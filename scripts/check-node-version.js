const supportedMajor = 20;
const currentVersion = process.versions.node;
const currentMajor = Number.parseInt(currentVersion.split(".")[0] || "", 10);

if (currentMajor !== supportedMajor) {
  console.error(
    [
      `remcodex requires Node.js ${supportedMajor}.x for the published package.`,
      `Current Node.js: ${currentVersion}`,
      "Switch Node versions first, then reinstall remcodex so native modules are built against the same runtime.",
    ].join("\n"),
  );
  process.exit(1);
}
