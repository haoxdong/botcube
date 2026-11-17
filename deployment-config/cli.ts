#!/usr/bin/env node
// `botcube footprint <deployment-config.json>`: what that Deployment Config needs from its AWS account (ADR 0091).
import { registerHooks } from 'node:module';

// Node strips the seam's types but keeps its `.js` import specifiers, which name the `.ts` file beside them.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!/^\.\.?\/.*\.js$/.test(specifier)) throw error;
      return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
    }
  },
});

const { footprint, formatFootprint } = await import('./footprint.ts');
const { DeploymentConfigError, loadDeployment } = await import('./load.ts');

const [command, path, ...rest] = process.argv.slice(2);
if (command !== 'footprint' || !path || rest.length) {
  process.stderr.write('Usage: botcube footprint <deployment-config.json>\n');
  process.exit(2);
}
try {
  process.stdout.write(formatFootprint(footprint(loadDeployment(path).config)));
} catch (error) {
  if (!(error instanceof DeploymentConfigError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
