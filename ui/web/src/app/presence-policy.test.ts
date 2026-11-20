import { describe, expect, it } from 'vitest';
import { bareVisibleMounts } from '../../test/presence-policy';

describe('conditional mount ownership', () => {
  it.each([
    '<main>{error && <p role="alert">Failed</p>}</main>',
    '<main>{editing ? <Editor /> : <Document />}</main>',
    '<main>{open && <><p>Message</p><button>Retry</button></>}</main>',
    '<Presence>{open && <div>Unanimated</div>}</Presence>',
    '<Presence><div>{open && <m.div exit={{opacity:0}} />}</div></Presence>',
    '<Swap state="fixed"><div>{open && <button>Delete</button>}</div></Swap>',
    '<main>{open && <Suspense><button>Action</button></Suspense>}</main>',
    '<main>{open && <p hidden={false}>Visible</p>}</main>',
    '<main>{open && <input type="file" />}</main>',
  ])('rejects a visible mount without presence: %s', (source) => {
    expect(bareVisibleMounts(source).length).toBeGreaterThan(0);
  });

  it.each([
    '<Presence>{open && <m.div initial={{opacity:0}} exit={{opacity:0}}>Panel</m.div>}</Presence>',
    '<Swap state={editing}>{editing ? <Editor /> : <Document />}</Swap>',
    '<main>{kept && <Sheet open={open}>Contents</Sheet>}</main>',
    '<main>{earlier && <div data-chat-earlier aria-hidden />}</main>',
    '<RowCollapse open={failed}>{failed && <LoadFailed />}</RowCollapse>',
    '<AnimatePresence>{open && <Collapsible>Steps</Collapsible>}</AnimatePresence>',
  ])('accepts a retained owner or nonvisual marker: %s', (source) => {
    expect(bareVisibleMounts(source)).toEqual([]);
  });
});
