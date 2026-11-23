import type { z } from 'zod';
import type { botcubeConfig } from './schema.js' with { 'resolution-mode': 'import' };

export function readConfigSource(path: string, ErrorType?: new (message: string) => Error): unknown;
export function readConfig(path: string): z.input<typeof botcubeConfig>;
export function webOrigins(config: { domains?: z.input<typeof botcubeConfig>['domains'] | undefined }): string[] | undefined;
export function botDirectoryErrors(botDirectory: string, deployRoot?: string): string[];
export function checkBotDirectory(botDirectory: string, deployRoot?: string): void;
export type DeploymentConfig = z.input<typeof botcubeConfig> & {
  name: string;
  env: { account: string; region: string };
  domains: NonNullable<z.input<typeof botcubeConfig>['domains']>;
};
export function readDeployment(deployRoot: string): DeploymentConfig;
export { deploymentNames, fillName } from './names.cjs';
export function secretResource(secretId: string, where: { partition: string; region: string; account: string }): string;
export function parseYaml(text: string, source: string, ErrorType?: new (message: string) => Error): unknown;
