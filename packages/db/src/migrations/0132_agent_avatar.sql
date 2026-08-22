ALTER TABLE "agents" ADD COLUMN "avatar_asset_id" uuid;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_avatar_asset_id_assets_id_fk" FOREIGN KEY ("avatar_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;
