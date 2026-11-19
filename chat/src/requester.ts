/** The account that sent a request, as the Cartridge resolved it from the request. */
export interface Requester {
  /** The Account tier resolved by the Cartridge, never supplied by the client. */
  readonly rateTier?: string;
  /** The account that owns the requester's Sessions: the one its Turns are filed under. */
  readonly owner: string;
  readonly anonymous?: boolean;
}
