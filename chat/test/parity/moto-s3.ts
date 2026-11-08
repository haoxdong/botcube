import { AWS_ACCESS_KEY_ID } from '../fakes/credentials.js';

// moto checks no signature; a SigV4-shaped header names the access key.
const AUTHORIZATION = `AWS4-HMAC-SHA256 Credential=${AWS_ACCESS_KEY_ID}/20260101/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=0`;

/** The suite's local S3 (moto), addressed path-style. */
export class MotoS3 {
  constructor(readonly endpoint: string) {}

  private async send(method: string, path: string, body: string | null = null): Promise<Response> {
    const response = await fetch(`${this.endpoint}/${path}`, { method, headers: { authorization: AUTHORIZATION }, body });
    if (response.status !== 200) throw new Error(`S3 ${method} ${path}: ${response.status} ${await response.text()}`);
    return response;
  }

  async createBucket(bucket: string): Promise<void> {
    await this.send('PUT', bucket);
  }

  /** Keep every version of every key, as S3 Files needs of its bucket. */
  async enableVersioning(bucket: string): Promise<void> {
    await this.send(
      'PUT',
      `${bucket}?versioning`,
      '<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>',
    );
  }

  async putObject(bucket: string, key: string, body: string): Promise<void> {
    await this.send('PUT', `${bucket}/${key}`, body);
  }

  async getObject(bucket: string, key: string): Promise<string> {
    return (await this.send('GET', `${bucket}/${key}`)).text();
  }

  /** The keys of the objects under a prefix. */
  async keys(bucket: string, prefix: string): Promise<string[]> {
    const listing = await (await this.send('GET', `${bucket}?list-type=2&prefix=${encodeURIComponent(prefix)}`)).text();
    return [...listing.matchAll(/<Contents>.*?<Key>(.*?)<\/Key>/gs)].map(([, key]) => key ?? '');
  }

  /** Every version and delete marker under a prefix, each as `<kind> <key>`. */
  async versions(bucket: string, prefix: string): Promise<string[]> {
    const listing = await (await this.send('GET', `${bucket}?versions&prefix=${encodeURIComponent(prefix)}`)).text();
    return [...listing.matchAll(/<(Version|DeleteMarker)>.*?<Key>(.*?)<\/Key>/gs)].map(([, kind, key]) => `${kind} ${key}`);
  }
}
