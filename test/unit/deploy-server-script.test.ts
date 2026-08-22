import { describe, it, expect } from "vitest";
import deployScriptContent from "../../scripts/deploy-server.sh?raw";

describe("scripts/deploy-server.sh deployment version metadata publication", () => {
  it("protects existing .version during rsync and never writes .version before health check passes", () => {
    const content = deployScriptContent;

    const rsyncIndex = content.indexOf("Syncing project files to");
    const dockerIndex = content.indexOf("Building and starting Docker Compose containers");
    const healthCheckIndex = content.indexOf("Polling container health");
    const healthCheckFailExitIndex = content.indexOf('echo "❌ Error: oma-server failed health check after 60s."');
    const versionPublishIndex = content.indexOf("Publishing deploy version stamp");

    expect(rsyncIndex, "rsync step must exist").toBeGreaterThan(-1);
    expect(dockerIndex, "docker compose step must exist").toBeGreaterThan(rsyncIndex);
    expect(healthCheckIndex, "health check step must exist").toBeGreaterThan(dockerIndex);
    expect(healthCheckFailExitIndex, "health check failure exit must exist").toBeGreaterThan(healthCheckIndex);
    expect(versionPublishIndex, "version publication must happen after health check failure exit").toBeGreaterThan(healthCheckFailExitIndex);

    // P1-2: rsync --delete must exclude .version* so previous version stamp is preserved during sync & build
    const rsyncBlock = content.slice(rsyncIndex, dockerIndex);
    expect(rsyncBlock).toContain("--exclude '.version*'");

    // P1-2: No writes/redirections to .version before the health check succeeds
    const preHealthCheckContent = content.slice(0, healthCheckFailExitIndex);
    expect(preHealthCheckContent).not.toMatch(/>\s*(\$\{TARGET_DIR\}|\$TARGET_DIR)?\/?\.version/);
    expect(preHealthCheckContent).not.toMatch(/mv\s+.*\.version/);
  });

  it("publishes .version atomically using mktemp and mv on the target directory", () => {
    const content = deployScriptContent;

    const versionBlock = content.slice(content.indexOf("Publishing deploy version stamp"));

    // 1. Creates a temp file in ${TARGET_DIR} for same-filesystem atomic rename
    expect(versionBlock).toContain('TMP_VER=\\"\\$(mktemp ${TARGET_DIR}/.version.tmp.XXXXXX)\\"');

    // 2. Writes commit SHA and deployment timestamp into temp file
    expect(versionBlock).toContain("GIT_COMMIT_SHA=");
    expect(versionBlock).toContain("DEPLOYED_AT=");

    // 3. Atomically moves the temporary file to destination
    expect(versionBlock).toContain('mv -f \\"\\${TMP_VER}\\" ${TARGET_DIR}/.version');
  });

  it("enforces clean git working tree including untracked files via status --porcelain unless ALLOW_DIRTY=1", () => {
    const content = deployScriptContent;

    // P1-3: Safety gate must check status --porcelain to catch untracked and modified files
    expect(content).toContain('if [ "${ALLOW_DIRTY}" != "1" ]; then');
    expect(content).toContain("status --porcelain");
    expect(content).toContain("status --short");
  });

  it("ensures bash strict mode flags are set", () => {
    const content = deployScriptContent;
    expect(content).toContain("set -euo pipefail");
  });
});
