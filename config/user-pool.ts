import { z } from 'zod';

// Interim until the maintainer settles a signIn kind for Cognito: the user pool the deployment's own app creates.
export const userPool = z.strictObject({
  userPoolName: z.string().min(1).describe('As CloudFormation UserPool.UserPoolName.'),
  domain: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Expected a domain prefix').describe("As CloudFormation UserPoolDomain.Domain: the managed login's <domain>.auth.<region>.amazoncognito.com."),
  customDomain: z.strictObject({
    domain: z.string().min(1).describe('As CloudFormation UserPoolDomain.Domain, for a custom domain.'),
    certificateArn: z.string().regex(/^arn:aws[a-z-]*:acm:us-east-1:\d{12}:certificate\/.+$/, 'Expected an ACM certificate ARN in us-east-1')
      .describe('As CloudFormation CustomDomainConfig.CertificateArn.'),
  }).optional().describe("The managed login's own host, once its certificate is issued."),
  callbackUrls: z.array(z.url({ protocol: /^https$/ })).min(1).describe("As CDK OAuthSettings.callbackUrls: the Chat Service's /auth/oidc/callback on each of its origins."),
  logoutUrls: z.array(z.url({ protocol: /^https$/ })).min(1).describe('As CDK OAuthSettings.logoutUrls: where /logout may return the browser.'),
  email: z.strictObject({
    sesVerifiedDomain: z.string().min(1).describe('As CDK UserPoolSESOptions.sesVerifiedDomain: the SES domain identity codes are sent from.'),
    fromEmail: z.email().describe('As CDK UserPoolSESOptions.fromEmail.'),
    fromName: z.string().min(1).describe('As CDK UserPoolSESOptions.fromName.'),
    sesVerified: z.boolean().describe("BotCube-owned: whether SES has verified the domain; until then Cognito's own sender sends."),
  }),
  google: z.strictObject({
    credential: z.strictObject({ secretId: z.string().min(1).describe('A Secrets Manager secret name or ARN, holding client_id and client_secret.') }),
  }).optional().describe('Google, on once its secret holds its credentials.'),
  login: z.boolean().optional().describe('BotCube-owned: whether the Chat Service and the Credential Service read this file, whose oidc signIn turns the managed sign-in on.'),
}).describe('Interim: the Cognito user pool the deployment creates for this provider, by its CloudFormation names.');
