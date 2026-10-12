import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { App, Stack } from 'aws-cdk-lib';
import { DockerImageAsset, Platform } from 'aws-cdk-lib/aws-ecr-assets';

test('stages application and tool sources without root or nested virtual environments', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentcore-docker-context-'));
  const sourceDir = path.join(tempRoot, 'source');
  const files: Record<string, string> = {
    'session-api.Dockerfile': 'FROM scratch\nCOPY . /app\n',
    'session_api.py': 'application source\n',
    'tools/tool.py': 'tool source\n',
    '.venv/root-marker': 'root virtual environment\n',
    'tools/.venv/nested-marker': 'nested virtual environment\n',
  };

  try {
    for (const [file, content] of Object.entries(files)) {
      const destination = path.join(sourceDir, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, content);
    }
    fs.copyFileSync(
      path.resolve(__dirname, '../../../../harness/deepagents/.dockerignore'),
      path.join(sourceDir, '.dockerignore')
    );
    const app = new App({ outdir: path.join(tempRoot, 'cdk.out') });
    const stack = new Stack(app, 'DockerContextStack');
    new DockerImageAsset(stack, 'SessionApiAsset', {
      directory: sourceDir,
      file: 'session-api.Dockerfile',
      platform: Platform.LINUX_ARM64,
    });
    const assembly = app.synth();
    const manifest: { dockerImages: Record<string, { source: { directory: string } }> } = JSON.parse(
      fs.readFileSync(path.join(assembly.directory, `${stack.artifactId}.assets.json`), 'utf8')
    );
    const images = Object.values(manifest.dockerImages);
    expect(images).toHaveLength(1);
    const image = images[0];
    if (!image) throw new Error('Docker asset missing from synthesized manifest');
    const stagedDir = path.join(assembly.directory, image.source.directory);

    expect(fs.readFileSync(path.join(stagedDir, 'session_api.py'), 'utf8')).toBe('application source\n');
    expect(fs.readFileSync(path.join(stagedDir, 'tools/tool.py'), 'utf8')).toBe('tool source\n');
    expect(fs.existsSync(path.join(stagedDir, '.venv/root-marker'))).toBe(false);
    expect(fs.existsSync(path.join(stagedDir, 'tools/.venv/nested-marker'))).toBe(false);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
