import { z } from 'zod';
import { kmsKeyArn } from 'botcube-config/blocks';

const accessPointId = z.string().regex(/^fsap-[0-9a-f]+$/);
/** `existing.files` (ADR 0091): the root-directory rule is the deploy-time pool's, so a User's directory behaves the same. */
const existingFiles = z
  .strictObject({
    fileSystemId: z.string().regex(/^fs-[0-9a-f]+$/).describe('The Files file system, with a mount target in each existing private subnet.'),
    kmsKey: kmsKeyArn.describe('The key the file system is encrypted with.'),
    accountsAccessPointId: accessPointId.describe("The Chat Service's access point: root directory /accounts, as uid and gid 1000."),
    accessPoints: z
      .array(z.strictObject({
        accessPointId,
        rootDirectory: z.string().regex(/^\/accounts\/[0-9a-f]{32}$/, 'Expected /accounts/ and 32 lowercase hex digits, as a deploy-time pool slot'),
      }))
      .min(1)
      .describe("The pool each User's access point is leased from on their first Files use, each as uid and gid 1000; none free, Files fail naming this field."),
  })
  .superRefine(({ accountsAccessPointId, accessPoints }, context) => {
    const seen = new Map([[accountsAccessPointId, 'existing.files.accountsAccessPointId']]);
    accessPoints.forEach(({ accessPointId: id, rootDirectory }, index) => {
      for (const [field, value, kind] of [['accessPointId', id, 'Access point'], ['rootDirectory', rootDirectory, 'Directory']] as const) {
        const first = seen.get(value);
        if (first) context.addIssue({ code: 'custom', path: ['accessPoints', index, field], message: `${kind} ${value} is already ${first}` });
        else seen.set(value, `existing.files.accessPoints.${index}`);
      }
    });
  })
  .describe(
    'The Files file system and the access points Users lease from it: BotCube creates neither, and no access point at runtime. '
    + "Each Turn mounts Files by the mount target's address, which the deploy reads from EFS. "
    + "ECS mounts the Chat Service's own volume by <fileSystemId>.efs.<region>.amazonaws.com, so the VPC's resolver must answer that name.",
  );

const kmsAliasArn = z
  .string()
  .regex(/^arn:aws[a-z-]*:kms:[a-z0-9-]+:\d{12}:alias\/.+$/, 'Expected a KMS alias ARN, such as arn:aws:kms:us-east-1:123456789012:alias/sign-in-sheet, so the key rotates by moving the alias');
const tableName = z.string().regex(/^[a-zA-Z0-9_.-]{3,255}$/);
const bucketName = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
const STREAM_ARN = /^arn:aws[a-z-]*:dynamodb:[a-z0-9-]+:\d{12}:table\/([a-zA-Z0-9_.-]+)\/stream\/.+$/;
const targetGroupArn = z.string().regex(/^arn:aws[a-z-]*:elasticloadbalancing:[a-z0-9-]+:\d{12}:targetgroup\/[a-zA-Z0-9-]{1,32}\/[0-9a-f]+$/);

// CDK's from…Attributes: only the attributes CDK needs to synthesize without AWS credentials are restated.
const subnetAttributes = z.strictObject({
  subnetId: z.string().regex(/^subnet-[0-9a-z]+$/),
  availabilityZone: z.string().min(1).describe('As CDK SubnetAttributes.availabilityZone, which CDK needs to synthesize without credentials.'),
});
const vpc = z
  .strictObject({
    vpcId: z.string().regex(/^vpc-[0-9a-z]+$/),
    publicSubnets: z.array(subnetAttributes).min(2).describe("The origin load balancer's subnets; with network.natGateways 1, the NAT is in the first."),
    privateSubnets: z
      .array(subnetAttributes.extend({
        ipv4CidrBlock: z.string().min(1).describe('As CDK SubnetAttributes.ipv4CidrBlock, which CDK needs to synthesize without credentials.'),
        routeTableId: z.string().regex(/^rtb-[0-9a-z]+$/).optional().describe('As CDK SubnetAttributes.routeTableId: with network.natGateways 1, all private subnets must name the same route table.'),
      }))
      .min(2)
      .describe("The services', browsers' and Lambdas' subnets."),
  })
  .describe("The VPC, as CDK VpcAttributes: BotCube creates none. With network.natGateways 0 or absent, its private subnets must already reach the internet.");

export const existing = z
  .strictObject({
    vpc,
    browsers: z
      .strictObject({
        link: z
          .strictObject({ browserId: z.string().min(1), securityGroupId: z.string().regex(/^sg-[0-9a-z]+$/) })
          .optional()
          .describe("The link browser, in existing.vpc's private subnets, and its security group."),
      })
      .optional(),
    kmsKeys: z
      .strictObject({
        vault: kmsKeyArn.optional().describe("Encrypts the Credential Service's vault."),
        sheet: kmsAliasArn
          .optional()
          .describe(
            'Decrypts what the Sign-in Sheet encrypts: the alias of an RSA ENCRYPT_DECRYPT key, which the Credential Service checks at startup. '
            + 'Rotate it by creating a new RSA key and moving the alias: no redeploy, and a sheet open across the move is re-opened. '
            + 'Only a Credential Service that mounts the Sign-in Sheet routes uses it.',
          ),
        memory: kmsKeyArn.optional().describe("Encrypts the agent's AgentCore Memory."),
        images: kmsKeyArn.optional().describe("Encrypts the bot's image repository."),
        functions: kmsKeyArn.optional().describe("Encrypts the Credential Service's audit-copy Lambda's environment in place of the AWS managed key."),
      })
      .optional(),
    tables: z
      .strictObject({
        chat: z
          .strictObject({ tableName, streamArn: z.string().regex(STREAM_ARN).describe("The table's NEW_IMAGE stream, which parking reads.") })
          .optional(),
        vault: z.strictObject({ tableName }).optional().describe("The Credential Service's vault: partition key accountId, sort key provider."),
      })
      .optional(),
    buckets: z
      .strictObject({
        connectionLogs: bucketName.optional().describe("The origin load balancer's connection logs."),
        slots: z.strictObject({ bucketName }).optional().describe("As CDK BucketAttributes: the bucket parking keeps the origin's slot in."),
      })
      .optional(),
    files: existingFiles.optional(),
    credentialService: z
      .strictObject({
        url: z
          .url({ protocol: /^https?$/ })
          .describe("The URL the Chat Service and the Harness call the Credential Service at, such as a DNS name in front of the target group; it authenticates them with its own invocation token."),
        targetGroupArn: targetGroupArn.describe("The IP target group in front of that URL, which BotCube registers the Credential Service's tasks into."),
        securityGroupId: z
          .string()
          .regex(/^sg-[0-9a-z]+$/)
          .describe("The security group of the load balancer in front of that target group: BotCube admits it to the Credential Service's port."),
      })
      .optional()
      .describe('A Credential Service Endpoint, for a network that refuses a private DNS namespace: BotCube creates no Cloud Map namespace or service.'),
  })
  .superRefine(({ tables }, context) => {
    const chat = tables?.chat;
    const streamTable = chat && STREAM_ARN.exec(chat.streamArn)?.[1];
    if (chat && streamTable !== chat.tableName) {
      context.addIssue({ code: 'custom', path: ['tables', 'chat', 'streamArn'], message: `The stream is table ${streamTable}'s, not ${chat.tableName}'s` });
    }
  })
  .describe("Resources the operator supplies, with their grants, instead of BotCube creating them: BotCube creates neither a existing resource nor a policy on it, and `botcube footprint` lists the grants each one needs. Each one left out, BotCube creates and grants.");
