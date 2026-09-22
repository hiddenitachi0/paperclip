"use strict";
/**
 * DUR-3994 Stage 2: stop Node from loading code from folders agents can write.
 *
 * Loaded first (`node --require <this file>`) by the Paperclip server in the
 * Docker image, and by every plugin worker it starts. The image installs it
 * root-owned, outside /app, so an agent cannot change it.
 *
 * Every agent runs as the same Linux user (`node`) as the server. Two Node
 * look-up rules would otherwise load an agent's file into the server:
 *
 *   1. Global folders. For `require()`, Node also looks in $HOME/.node_modules
 *      and $HOME/.node_libraries, and HOME is a folder agents can write. The
 *      server's dependencies try to load optional modules that are not
 *      installed (the `ws` package tries `bufferutil`), so a planted
 *      ~/.node_modules/bufferutil ran inside the server at the next start.
 *      Node works these folders out once, at start-up, before this file runs;
 *      they are worked out again here with HOME hidden, so they are gone.
 *      HOME itself is left as it was (the server's children need it).
 *
 *   2. Parent folders. A module is also looked for in every node_modules
 *      folder above the file that asks for it. Add-ons live under
 *      /paperclip, so a missing dependency of an add-on was looked for in
 *      /paperclip/node_modules -- writable, and outside the add-on's
 *      checked (fingerprinted) folder. A resolve hook now refuses any module
 *      that resolves into a folder agents can write (PAPERCLIP_HOME, HOME,
 *      the temp folders), unless it is inside an add-on folder the server
 *      has checked and allowed (see server/src/services/trusted-code.ts).
 *
 * Configuration (environment, set by the server, never by agents):
 *   PAPERCLIP_MODULE_GUARD_DENY  colon-separated folders to refuse (default:
 *                                PAPERCLIP_HOME, HOME and the temp folders)
 *   PAPERCLIP_MODULE_GUARD_ALLOW colon-separated folders inside those that
 *                                may be loaded from (a plugin worker's own
 *                                checked folder)
 */
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const GUARD_KEY = Symbol.for("paperclip.moduleGuard");

function splitList(value) {
  return String(value || "")
    .split(":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry))
    .map((entry) => path.resolve(entry));
}

function realOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function unique(list) {
  return [...new Set(list)];
}

if (!globalThis[GUARD_KEY]) {
  // 1. Global folders: recompute Node's search paths with HOME hidden.
  const savedHome = process.env.HOME;
  let globalPathsCleared = false;
  try {
    delete process.env.HOME;
    if (typeof Module._initPaths === "function") {
      Module._initPaths();
      globalPathsCleared = true;
    }
  } finally {
    if (savedHome !== undefined) process.env.HOME = savedHome;
  }

  // 2. Parent folders: a resolve hook.
  const denyFromEnv = splitList(process.env.PAPERCLIP_MODULE_GUARD_DENY);
  const denyRoots = unique(
    denyFromEnv.length > 0
      ? denyFromEnv
      : splitList(
          [process.env.PAPERCLIP_HOME, savedHome, os.tmpdir(), "/tmp", "/var/tmp", "/dev/shm"]
            .filter(Boolean)
            .join(":"),
        ),
  )
    .flatMap((root) => unique([root, realOrSelf(root)]))
    .filter((root) => root !== path.parse(root).root)
    // Never the program's own folder (the working directory, /app in the
    // image, which is root-owned): a checkout inside HOME must still run.
    .filter((root) => !isInside(realOrSelf(process.cwd()), root));
  const allowRoots = new Set(splitList(process.env.PAPERCLIP_MODULE_GUARD_ALLOW));
  delete process.env.PAPERCLIP_MODULE_GUARD_DENY;
  delete process.env.PAPERCLIP_MODULE_GUARD_ALLOW;

  function refusal(file) {
    for (const root of denyRoots) {
      if (!isInside(file, root)) continue;
      for (const allowed of allowRoots) {
        if (isInside(file, allowed)) return null;
      }
      return root;
    }
    return null;
  }

  function checkResolved(url, specifier, parentURL) {
    if (typeof url !== "string" || !url.startsWith("file:")) return;
    let file;
    try {
      file = fileURLToPath(url);
    } catch {
      return;
    }
    const deniedRoot = refusal(file);
    if (!deniedRoot) return;
    const error = new Error(
      `Paperclip refused to load "${specifier}" from ${file}: that folder (${deniedRoot}) can be changed by agents, ` +
        `and the file is not part of an add-on Paperclip installed and checked.` +
        (parentURL ? ` (asked for by ${parentURL})` : ""),
    );
    error.code = "ERR_MODULE_NOT_FOUND";
    throw error;
  }

  // module.registerHooks exists from Node 22.15, but before Node 24 it
  // cannot be combined with the asynchronous loader hooks tsx registers
  // (every import then fails with ERR_METHOD_NOT_IMPLEMENTED). The image runs
  // the current LTS (24 or later).
  const nodeMajor = Number(String(process.versions.node).split(".")[0]);
  let hooksActive = false;
  if (typeof Module.registerHooks === "function" && nodeMajor >= 24) {
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        const result = nextResolve(specifier, context);
        checkResolved(result && result.url, specifier, context && context.parentURL);
        return result;
      },
    });
    hooksActive = true;
  } else {
    process.emitWarning(
      `Paperclip module guard: Node.js ${process.versions.node} cannot run the module resolve check (it needs Node.js 24 or later), so modules loaded from folders agents can write are not refused`,
    );
  }

  globalThis[GUARD_KEY] = Object.freeze({
    preloadPath: __filename,
    globalPathsCleared,
    hooksActive,
    denyRoots: Object.freeze([...denyRoots]),
    allowRoot(dir) {
      if (typeof dir === "string" && path.isAbsolute(dir)) allowRoots.add(path.resolve(dir));
    },
    disallowRoot(dir) {
      if (typeof dir === "string") allowRoots.delete(path.resolve(dir));
    },
    allowedRoots() {
      return [...allowRoots];
    },
  });
}
