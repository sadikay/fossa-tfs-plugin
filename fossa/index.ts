import Axios from 'axios';
import * as decompress from 'decompress';
import * as fs from 'fs-extra';
import * as Path from 'path';
import * as tl from 'vsts-task-lib';

const OS = tl.getVariable('Agent.OS') as 'Linux' | 'Darwin' | 'Windows_NT';
tl.debug(`OS: ${OS}`);
let WorkingDirectory = tl.getPathInput('cwd');
tl.debug(`WorkingDirectory: ${WorkingDirectory}`);
if (!WorkingDirectory) {
  WorkingDirectory = tl.getVariable('Build.SourcesDirectory');
  tl.debug(`WorkingDirectory not set, defaulting to $Build.SourcesDirectory: ${WorkingDirectory}`);
}
const InstallMethod = tl.getInput('source', true) as 'INSTALL' | 'LOCAL';
tl.debug(`InstallMethod: ${InstallMethod}`);
const CLIVersion = tl.getInput('version');
tl.debug(`CLIVersion: ${CLIVersion}`);
let CLIPath: string;
let CLIConfig = tl.getInput('cliConfig');
tl.debug(`CLIConfig: ${CLIConfig}`);
const TempPath = tl.getVariable('Agent.TempDirectory');
tl.debug(`TempPath: ${TempPath}`);
const Service = tl.getInput('FOSSAService', true);
tl.debug(`Service: ${Service}`);
const EndpointURL = tl.getEndpointUrl(Service, true);
tl.debug(`EndpointURL: ${EndpointURL}`);
const ServiceAuthorization = tl.getEndpointAuthorization(Service, true);
const FOSSATest = tl.getInput('failOnError') as 'TEST' | 'SKIP';
tl.debug(`FOSSATest: ${FOSSATest}`);

const run = async () => {
  try {
    if (InstallMethod === 'INSTALL') {
      CLIPath = await install();
    } else {
      CLIPath = tl.getInput('path');
    }
    tl.debug(`CLIPath: ${CLIPath}`);

    tl.checkPath(WorkingDirectory, 'Source directory');
    const stat = tl.stats(WorkingDirectory);
    if (!stat.isDirectory()) {
      throw new Error(`Path ${WorkingDirectory} is not a directory. Please set the "Source directory" in your build step configuration to point to the directory that you want FOSSA to analyze.`);
    }
    tl.cd(WorkingDirectory);

    await analyze();

    if (FOSSATest === 'TEST') {
      await test();
    }
  } catch (err) {
    tl.setResult(tl.TaskResult.Failed, err.message);
  }
};

const analyze = async () => {
  tl.checkPath(CLIConfig, 'Config File');
  const stat = tl.stats(CLIConfig);
  if (!stat.isFile()) {
    tl.debug(`CLIConfig path ${CLIConfig} either does not exist or is not a file. Unsetting and running \`fossa init\``);
    CLIConfig = undefined;
  }

  if (!CLIConfig) {
    tl.debug('No configuration file provided, running `fossa init`');
    await tl.exec(CLIPath, 'init');
  }

  const fossa = tl.tool(CLIPath);
  fossa.arg('analyze');
  fossa.arg(['--endpoint', EndpointURL]);
  fossa.argIf(!!CLIConfig, ['--config', CLIConfig]);
  tl.setVariable('FOSSA_API_KEY', ServiceAuthorization.parameters.apitoken, true);
  await fossa.exec();
  tl.setVariable('FOSSA_API_KEY', null);
};

const install = async (): Promise<string> => {
  const downloadURL = buildDownloadURL();
  const archivePath = Path.resolve(TempPath, 'fossa-archive');
  const CLIDirectory = Path.resolve(TempPath, 'fossa');
  tl.debug(`Downloading fossa-cli from ${downloadURL} to ${archivePath} and extracting to ${CLIDirectory}`);
  const file = fs.createWriteStream(archivePath);

  const response = await Axios.get(downloadURL, { responseType: 'stream' });
  response.data.pipe(file);

  await new Promise((resolve, reject) => {
    response.data.on('end', () => {
      file.close();
      resolve(archivePath);
    });
    response.data.on('error', (err) => {
      file.destroy();
      reject(err);
    });
  });

  await decompress(archivePath, CLIDirectory);

  if (OS === 'Windows_NT') {
    return Path.resolve(CLIDirectory, 'fossa.exe');
  }
  return Path.resolve(CLIDirectory, 'fossa');
};

const test = async () => {
  const fossa = tl.tool(CLIPath);
  fossa.arg('test');
  fossa.arg(['--endpoint', EndpointURL]);
  fossa.argIf(!!CLIConfig, ['--config', CLIConfig]);
  tl.setVariable('FOSSA_API_KEY', ServiceAuthorization.parameters.apitoken, true);
  await fossa.exec();
  tl.setVariable('FOSSA_API_KEY', null);
};

const buildDownloadURL = () => {
  let os;
  let arch;
  let format = 'tar.gz';

  switch(OS) {
    case 'Linux':
      os = 'linux';
      break;
    case 'Darwin':
      os = 'darwin';
      break;
    case 'Windows_NT':
      os = 'windows';
      format = 'zip';
      break;
    default:
      throw new Error(`Agent is running an unsupported operating system: ${OS}`);
  }

  if (process.arch === 'x64') {
    arch = 'amd64';
  } else {
    throw new Error(`Agent is running an unsupported architecture: ${process.arch}`);
  }

  return `https://github.com/fossas/fossa-cli/releases/download/${CLIVersion}/fossa-cli_${CLIVersion.substring(1)}_${os}_${arch}.${format}`;
};

run();
