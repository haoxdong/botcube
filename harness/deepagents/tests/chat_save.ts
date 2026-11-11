import { ArtifactSave, saveArtifact } from '../../../chat/src/artifact-save.ts';

if (process.argv.length !== 4) throw new Error('usage: chat_save.ts <Files directory> <save JSON>');
const [directory, save] = process.argv.slice(2) as [string, string];
process.stdout.write(JSON.stringify(await saveArtifact(directory, ArtifactSave.parse(JSON.parse(save)))));
