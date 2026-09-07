import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerApprovalCommands } from "../commands/client/approval.js";

// DUR-3952 follow-up: `approval create --help` is where an agent learns how
// to file a deploy card. It must list request_board_approval as a type and
// show a working deploy example, so nobody guesses a kind the runner ignores.
describe("approval create help", () => {
  it("lists request_board_approval and shows a deploy example", () => {
    const program = new Command();
    registerApprovalCommands(program);
    const approval = program.commands.find((cmd) => cmd.name() === "approval");
    const create = approval?.commands.find((cmd) => cmd.name() === "create");
    expect(create).toBeDefined();

    // helpInformation() leaves out addHelpText() blocks; outputHelp() is what
    // `--help` actually prints, examples included.
    let help = "";
    create!.configureOutput({ writeOut: (text) => { help += text; }, writeErr: () => {} });
    create!.outputHelp();
    expect(help).toContain("request_board_approval");
    expect(help).toContain("hire_agent");
    expect(help).toContain('"kind": "deploy"');
    expect(help).toContain("allowBackwardDeploy");
    expect(help).toContain("Roll back to previous version");
  });
});
