import * as fs from 'node:fs';
import * as path from 'node:path';

/** This project's directory holds cdk.json, whether the app runs from source or from dist/. */
export function projectDir(dir: string): string {
  if (fs.existsSync(path.join(dir, 'cdk.json'))) return dir;
  if (path.dirname(dir) === dir) throw new Error('The ECS CDK app has no cdk.json above it');
  return projectDir(path.dirname(dir));
}
