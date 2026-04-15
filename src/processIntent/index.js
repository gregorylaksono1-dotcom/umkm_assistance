import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { runIntentProcessingPipeline } from "./intentPipeline.js";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const pipelineDeps = {
  ddb,
  tableMessage: process.env.TABLE_MESSAGE,
  tableSenderMeta: process.env.TABLE_SENDER_META,
  tableBillingUsageCredit: process.env.TABLE_BILLING_USAGE_CREDIT,
  tableRequestResource: process.env.TABLE_REQUEST_RESOURCE,
  midtransSecretArn: process.env.MIDTRANS_SECRET_ARN,
  geminiSecretArn: process.env.GEMINI_SECRET_ARN,
  geminiSecretKey: process.env.GEMINI_SECRET_KEY ?? "gemini_api_key",
  gsiSenderTime: process.env.GSI_SENDER_TIME ?? "GSI1",
  gsiRequestUserProcess:
    process.env.GSI_REQUEST_USER_PROCESS ?? "userProcess",
};

/**
 * Lambda process-intent: orkestrasi ringkas — detail di intentPipeline.js.
 */
export async function handler(event) {
  return runIntentProcessingPipeline(pipelineDeps, event);
}
