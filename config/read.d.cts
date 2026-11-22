import type { z } from 'zod';
import type { botcubeConfig } from './schema.js' with { 'resolution-mode': 'import' };

export function readConfigSource(path: string, ErrorType?: new (message: string) => Error): unknown;
export function readConfig(path: string): z.input<typeof botcubeConfig>;
export function webOrigins(config: { domains?: z.input<typeof botcubeConfig>['domains'] | undefined }): string[] | undefined;
export function botDirectoryErrors(botDirectory: string, deployRoot?: string): string[];
export function checkBotDirectory(botDirectory: string, deployRoot?: string): void;
export interface DeployRootOptions {
  /** What a file path is given relative to; absent, BotCube's root. */
  repositoryRoot?: string;
}
export function deploymentFile(config: z.input<typeof botcubeConfig>, file: string, options: DeployRootOptions & { configPath: string }): unknown;
export interface DeployRootFiles {
  readonly config: Partial<z.input<typeof botcubeConfig>>;
  file(file: string): unknown;
}
export function deployRootFiles(deployRoot: string, options?: DeployRootOptions): DeployRootFiles;
export function deployRootFile(deployRoot: string, file: string, options?: DeployRootOptions): unknown;
export function secretResource(secretId: string, where: { partition: string; region: string; account: string }): string;
export function parseYaml(text: string, source: string, ErrorType?: new (message: string) => Error): unknown;
