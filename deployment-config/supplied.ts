import { z } from 'zod';
import { kmsKeyArn } from 'botcube-deployment-config/blocks';

const accessPointId = z.string().regex(/^fsap-[0-9a-f]+$/);
/** `supplied.files` (ADR 0091): the root-directory rule is the deploy-time pool's, so a User's directory behaves the same. */
const suppliedFiles = z
  .strictObject({
    fileSystemId: z.string().regex(/^fs-[0-9a-f]+$/).describe('The Files file system, with a mount target in each supplied private subnet.'),
    kmsKey: kmsKeyArn.describe('The key the file system is encrypted with.'),
    accountsAccessPointId: accessPointId.describe("The Chat Service's and the Files links function's access point: root directory /accounts, as uid and gid 1000."),
    accessPoints: z
      .array(z.strictObject({
        accessPointId,
        rootDirectory: z.string().regex(/^\/accounts\/[0-9a-f]{32}$/, 'Expected /accounts/ and 32 lowercase hex digits, as a deploy-time pool slot'),
      }))
      .min(1)
      .describe("The pool each User's access point is leased from on their first Files use, each as uid and gid 1000; none free, Files fail naming this field."),
  })
  .superRefine(({ accountsAccessPointId, accessPoints }, context) => {
    const seen = new Map([[accountsAccessPointId, 'supplied.files.accountsAccessPointId']]);
    accessPoints.forEach(({ accessPointId: id, rootDirectory }, index) => {
      for (const [field, value, kind] of [['accessPointId', id, 'Access point'], ['rootDirectory', rootDirectory, 'Directory']] as const) {
        const first = seen.get(value);
        if (first) context.addIssue({ code: 'custom', path: ['accessPoints', index, field], message: `${kind} ${value} is already ${first}` });
        else seen.set(value, `supplied.files.accessPoints.${index}`);
      }
    });
  })
  .describe(
    'The Files file system and the access points Users lease from it: BotCube creates neither, and no access point at runtime. '
    + "The supplied VPC must use Amazon-provided DNS (enableDnsSupport and enableDnsHostnames): the Chat Service finds the file system's mount target as <fileSystemId>.efs.<region>.amazonaws.com.",
  );

const subnet = z.strictObject({ subnetId: z.string().regex(/^subnet-[0-9a-z]+$/), availabilityZone: z.string().min(1) });
const sheetKey = z.strictObject({
  keyArn: kmsKeyArn,
  keySpec: z.enum(['RSA_2048', 'RSA_3072', 'RSA_4096'], { error: 'The Sign-in Sheet key must be an RSA key (RSA_2048, RSA_3072 or RSA_4096)' })
    .describe("The key's KeySpec, which its ARN cannot show."),
});
const tableName = z.string().regex(/^[a-zA-Z0-9_.-]{3,255}$/);
const bucketName = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
const STREAM_ARN = /^arn:aws[a-z-]*:dynamodb:[a-z0-9-]+:\d{12}:table\/([a-zA-Z0-9_.-]+)\/stream\/.+$/;
const targetGroupArn = z.string().regex(/^arn:aws[a-z-]*:elasticloadbalancing:[a-z0-9-]+:\d{12}:targetgroup\/[a-zA-Z0-9-]{1,32}\/[0-9a-f]+$/);

export const supplied = z
  .strictObject({
    network: z
      .strictObject({
        vpcId: z.string().regex(/^vpc-[0-9a-z]+$/),
        publicSubnets: z.array(subnet).min(2).describe("The origin load balancer's subnets."),
        privateSubnets: z
          .array(subnet.extend({ cidrBlock: z.string().min(1) }))
          .min(2)
          .describe("The services', browsers' and Lambdas' subnets, which must already reach the internet; the proxy carries only the services' own traffic."),
      })
      .optional()
      .describe("A network that brings its own egress: BotCube creates, routes and parks no NAT in it, so the deploy identity names no aws.ecs.privateEgress."),
    kmsKeys: z
      .strictObject({
        vault: kmsKeyArn.optional().describe("Encrypts the Credential Service's vault."),
        sheet: sheetKey.optional().describe('Decrypts what the Sign-in Sheet encrypts: an RSA ENCRYPT_DECRYPT key. Only a Credential Service that mounts the Sign-in Sheet routes uses it.'),
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
      })
      .optional(),
    files: suppliedFiles.optional(),
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
  .superRefine(({ tables, files, network }, context) => {
    if (files && !network) {
      context.addIssue({ code: 'custom', path: ['files'], message: "Supplied Files need supplied.network: the file system's mount targets are in its private subnets" });
    }
    const chat = tables?.chat;
    const streamTable = chat && STREAM_ARN.exec(chat.streamArn)?.[1];
    if (chat && streamTable !== chat.tableName) {
      context.addIssue({ code: 'custom', path: ['tables', 'chat', 'streamArn'], message: `The stream is table ${streamTable}'s, not ${chat.tableName}'s` });
    }
  })
  .describe("Resources the operator supplies, with their grants, instead of BotCube creating them: BotCube creates neither a supplied resource nor a policy on it, and `botcube footprint` lists the grants each one needs. Each one left out, BotCube creates and grants.");
