import type { ChatStorageStack } from './chat-storage-stack.js';
import type { DeployIdentity } from './production-identity.js';

/** The roles that mount a existing file system, by the names the operator's grants on it give them before the first deploy. */
export function existingFilesRoleNames({ existingFiles }: ChatStorageStack, { chatServiceTaskRole, filesMountRole, agentComputerBrowserRole }: DeployIdentity['aws']['iam']) {
  if (!existingFiles) return undefined;
  const required = (field: string, name: string | undefined) => {
    if (!name) throw new Error(`Deploy identity aws.iam.${field}: required with existing.files, whose grants name the role`);
    return name;
  };
  return {
    chatServiceTaskRole: required('chatServiceTaskRole', chatServiceTaskRole),
    filesMountRole: required('filesMountRole', filesMountRole),
    agentComputerBrowserRole: required('agentComputerBrowserRole', agentComputerBrowserRole),
  };
}
