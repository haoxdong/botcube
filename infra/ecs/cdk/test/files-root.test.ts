// The Chat Service reads Files where its task mounts them. The CDK cannot import the Chat Service's sources into its
// own build, so this test, outside that build, holds the two paths together.
import { FILES_EFS_ROOT } from '../../../../chat/src/files-shared.js';
import { CHAT_FILES_MOUNT } from '../lib/files-links.js';

test('the Chat Service task mounts Files where the Chat Service reads them', () => {
  expect(FILES_EFS_ROOT).toEqual(expect.any(String));
  expect(CHAT_FILES_MOUNT).toBe(FILES_EFS_ROOT);
});
