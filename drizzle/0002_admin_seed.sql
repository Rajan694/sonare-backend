-- The first admin login. The password is stored only as this bcrypt hash (cost 12); change it
-- from the admin page's Account section after the first sign-in.
INSERT INTO "admin_users" ("username", "password_hash")
VALUES ('rajanadmin', '$2b$12$3Qpu2mWFZn8Kg/8JKydSBOJY537C7Yc3adRjKHBsG2cYaZ0QnMkYW')
ON CONFLICT ("username") DO NOTHING;
--> statement-breakpoint
-- System-wide settings the admin page edits. A null value falls back to the .env / file default.
INSERT INTO "system_configuration" ("key", "value", "description", "updated_by") VALUES
  ('piped.apiUrl', NULL, 'Piped API the backend reads the catalog and streams from. Applied immediately.', 'migration'),
  ('piped.proxyUrl', NULL, 'piped-proxy URL that Piped rewrites media URLs to (PROXY_PART in config.properties). Applied on the next ./runPiped.sh up.', 'migration'),
  ('piped.extractorCommit', '"13a655fe53e0c3065f88725fc1fb594c3ede0169"', 'NewPipeExtractor commit Piped is built against (build.gradle). Applied on the next ./runPiped.sh up, which rebuilds the image.', 'migration')
ON CONFLICT ("key") DO NOTHING;
