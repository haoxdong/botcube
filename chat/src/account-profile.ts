import { Hono, type Context } from 'hono';
import { HttpError } from './cartridge.js';
import { picture, pictureUrl, type Picture } from './pictures.js';
import { jsonPayload } from './payload.js';
interface ProfileAccount { accountId: string; displayName?: string; }
interface ProfileStore {
  photo(accountId: string): Promise<Picture | null>;
  updateProfile(accountId: string, profile: { displayName: string }): Promise<ProfileAccount>;
  savePhoto(accountId: string, photo: Picture | null): Promise<void>;
}
/** Profile routes use the Cartridge's trusted account session. */
export function accountProfileRoutes({ signedInAccount, store }: { signedInAccount(c: Context): Promise<ProfileAccount>; store(): ProfileStore }): Hono {
  const routes = new Hono();
  const profile = async (account: ProfileAccount) => {
    const photo = await store().photo(account.accountId);
    return { displayName: account.displayName ?? null, photoUrl: photo && pictureUrl(photo) };
  };

  routes.get('/account/profile', async (c) => c.json(await profile(await signedInAccount(c))));

  routes.post('/account/profile', async (c) => {
    const account = await signedInAccount(c);
    const payload = await jsonPayload(c);
    const displayName = typeof payload?.displayName === 'string' ? payload.displayName.trim() : '';
    if (!displayName) throw new HttpError(400, 'displayName is required');
    return c.json(await profile(await store().updateProfile(account.accountId, { displayName })));
  });

  // The user's photo: an item of its own, so loading the account never reads it.
  routes.put('/account/photo', async (c) => {
    const account = await signedInAccount(c);
    const payload = await jsonPayload(c);
    await store().savePhoto(account.accountId, picture(payload?.photo, 'Your photo'));
    return c.body(null, 204);
  });

  routes.delete('/account/photo', async (c) => {
    await store().savePhoto((await signedInAccount(c)).accountId, null);
    return c.body(null, 204);
  });

  return routes;
}
