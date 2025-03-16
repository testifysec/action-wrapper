const core = require("@actions/core");
const exec = require("@actions/exec");
const fs = require("fs");
const os = require("os");
const path = require("path");
const axios = require("axios");
const unzipper = require("unzipper");
const yaml = require("js-yaml");

async function run() {
  try {
    // Get inputs
    const actionRef = core.getInput("action-ref");
    const extraArgs = core.getInput("extra-args") || "";

    // Parse action-ref (expects format: owner/repo@ref)
    const [repo, ref] = parseActionRef(actionRef);
    core.info(`Parsed repo: ${repo}, ref: ${ref}`);

    // Construct URL for the repository zip archive
    const zipUrl = `https://github.com/${repo}/archive/${ref}.zip`;
    core.info(`Downloading action from: ${zipUrl}`);

    // Create a temporary directory for extraction
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nested-action-"));

    // Download and extract the zip archive
    const response = await axios({
      url: zipUrl,
      method: "GET",
      responseType: "stream"
    });
    await new Promise((resolve, reject) => {
      response.data
        .pipe(unzipper.Extract({ path: tempDir }))
        .on("close", resolve)
        .on("error", reject);
    });
    core.info(`Downloaded and extracted to ${tempDir}`);

    // GitHub archives typically extract to a folder named "repo-ref"
    const repoName = repo.split("/")[1];
    const extractedFolder = path.join(tempDir, `${repoName}-${ref}`);
    if (!fs.existsSync(extractedFolder)) {
      throw new Error(`Extracted folder ${extractedFolder} not found.`);
    }

    // Read action.yml from the downloaded action
    const actionYmlPath = path.join(extractedFolder, "action.yml");
    if (!fs.existsSync(actionYmlPath)) {
      throw new Error(`action.yml not found in ${extractedFolder}`);
    }
    const actionConfig = yaml.load(fs.readFileSync(actionYmlPath, "utf8"));
    const entryPoint = actionConfig.runs && actionConfig.runs.main;
    if (!entryPoint) {
      throw new Error("Entry point (runs.main) not defined in action.yml");
    }
    core.info(`Nested action entry point: ${entryPoint}`);

    // Construct full path to the nested action's entry file
    const entryFile = path.join(extractedFolder, entryPoint);
    if (!fs.existsSync(entryFile)) {
      throw new Error(`Entry file ${entryFile} does not exist.`);
    }

    // Optionally, install dependencies if package.json exists
    const pkgJsonPath = path.join(extractedFolder, "package.json");
    if (fs.existsSync(pkgJsonPath)) {
      core.info("Installing dependencies for nested action...");
      await exec.exec("npm", ["install"], { cwd: extractedFolder });
    }

    // Execute the nested action using Node.js
    const args = extraArgs.split(/\s+/).filter((a) => a); // split and remove empty strings
    core.info(`Executing nested action: node ${entryFile} ${args.join(" ")}`);
    await exec.exec("node", [entryFile, ...args], { cwd: extractedFolder });
    
  } catch (error) {
    core.setFailed(`Wrapper action failed: ${error.message}`);
  }
}

function parseActionRef(refString) {
  const parts = refString.split("@");
  if (parts.length !== 2) {
    throw new Error("Invalid action-ref format. Expected 'owner/repo@ref'");
  }
  return parts;
}

run();
