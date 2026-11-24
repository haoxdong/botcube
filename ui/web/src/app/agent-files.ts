import { chatServiceUrl } from "../plugin/chat-service-url";
import { attachmentAccountEpoch, FILE_ACCOUNT_LOCK } from "../plugin/file-account";
import { deleteFile, fileDownloadUrl, saveArtifact, uploadFile, type ArtifactSave, type UploadOptions } from "../computer/files-service";
import { filesPath, nameOf, type FilesPath } from "./files-path";

const CHAT_SERVICE_URL = chatServiceUrl();

/** The agent's files, on the Files routes every bot's Chat Service mounts (`botcube-chat/computer-files-routes`). */
export const agentFiles = {
  /** A short-lived URL for one of the agent's files. */
  url: (path: FilesPath) => fileDownloadUrl(nameOf(path), { chatServiceUrl: CHAT_SERVICE_URL, reply: true }),
  /** Uploads a file the user attached to the top of Files; resolves to the path the agent reads it by, such as `/report.csv`. */
  upload: async (file: File, options: UploadOptions) => filesPath(await uploadFile(file, options, { chatServiceUrl: CHAT_SERVICE_URL })),
  /** Saves the User's edit of an Artifact as its next version; resolves to that version, as the `Artifact` tool answers. */
  saveArtifact: (save: ArtifactSave) => saveArtifact(save, { chatServiceUrl: CHAT_SERVICE_URL }),
  /** Deletes a file an upload stored, by the path `upload` resolved to, while the account that attached it is signed in. */
  discard: (path: FilesPath, epoch: string | null) =>
    navigator.locks.request(FILE_ACCOUNT_LOCK, { mode: "shared" }, async () => {
      if (epoch !== attachmentAccountEpoch()) throw new Error("Your account changed since you attached it.");
      await deleteFile(nameOf(path), { chatServiceUrl: CHAT_SERVICE_URL });
    }),
};
