import type { Sql } from "./db";
import type { PaymentKind, PaymentMethod } from "./payment-types";

export type StoredPaymentIntent = {
  id: string;
  messageId: string;
  recipientId: string;
  senderId: string | null;
  capabilityHash: string | null;
  kind: PaymentKind;
  method: PaymentMethod;
  status: "pending" | "paid" | "failed";
  amount: string;
  recipientAddress: string | null;
  amountWei: string | null;
  nonceData: string | null;
  credentialId: string | null;
  invoiceId: string | null;
  checkoutUrl: string | null;
  providerPaymentId: string | null;
  transactionHash: string | null;
  confirmations: number;
  createdAt: Date | string;
  expiresAt: Date | string;
};
export type StoredPaymentCredential = {
  id: string;
  userId: string;
  encrypted: string;
  active: boolean;
};
const fields = `id, message_id as "messageId", recipient_id as "recipientId", sender_id as "senderId", capability_hash as "capabilityHash",
 kind, method, status, amount, recipient_address as "recipientAddress", amount_wei as "amountWei", nonce_data as "nonceData",
 credential_id as "credentialId", invoice_id as "invoiceId", checkout_url as "checkoutUrl", provider_payment_id as "providerPaymentId",
 transaction_hash as "transactionHash", confirmations, created_at as "createdAt", expires_at as "expiresAt"`;
export class PaymentProofConflictError extends Error {}
export function createSqlPaymentStore(sql: Pick<Sql, "query">) {
  return {
    async read(id: string): Promise<StoredPaymentIntent | null> {
      return (
        (
          await sql.query<StoredPaymentIntent>(
            `select ${fields} from creator_payment_intents where id=$1`,
            [id],
          )
        )[0] ?? null
      );
    },
    async create(
      input: Omit<
        StoredPaymentIntent,
        | "status"
        | "invoiceId"
        | "checkoutUrl"
        | "providerPaymentId"
        | "transactionHash"
        | "confirmations"
        | "createdAt"
      >,
    ) {
      const rows = await sql.query<StoredPaymentIntent>(
        `insert into creator_payment_intents
       (id,message_id,recipient_id,sender_id,capability_hash,kind,method,amount,recipient_address,amount_wei,nonce_data,credential_id,expires_at)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning ${fields}`,
        [
          input.id,
          input.messageId,
          input.recipientId,
          input.senderId,
          input.capabilityHash,
          input.kind,
          input.method,
          input.amount,
          input.recipientAddress,
          input.amountWei,
          input.nonceData,
          input.credentialId,
          input.expiresAt,
        ],
      );
      if (!rows[0]) throw new Error("Payment intent could not be saved");
      return rows[0];
    },
    async setInvoice(id: string, invoiceId: string, checkoutUrl: string) {
      await sql.query(
        `update creator_payment_intents set invoice_id=$2,checkout_url=$3 where id=$1 and status='pending'`,
        [id, invoiceId, checkoutUrl],
      );
    },
    async bindProviderPayment(id: string, credentialId: string, providerPaymentId: string) {
      const rows = await sql.query<{ id: string }>(
        `update creator_payment_intents set provider_payment_id=$3 where id=$1 and credential_id=$2 and method='nowpayments' and (status='pending' or provider_payment_id=$3) returning id`,
        [id, credentialId, providerPaymentId],
      );
      return rows.length === 1;
    },
    async setCandidate(id: string, hash: string | null) {
      await sql.query(
        `update creator_payment_intents set transaction_hash=$2 where id=$1 and status='pending' and method='ethereum'`,
        [id, hash],
      );
    },
    async acquireVerification(id: string) {
      return (
        (
          await sql.query<{ id: string }>(
            `update creator_payment_intents set last_verify_at=now() where id=$1 and status='pending' and (last_verify_at is null or last_verify_at < now()-interval '5 seconds') returning id`,
            [id],
          )
        ).length === 1
      );
    },
    async setConfirmations(id: string, confirmations: number) {
      await sql.query(
        `update creator_payment_intents set confirmations=$2 where id=$1 and status='pending'`,
        [id, confirmations],
      );
    },
    async fail(id: string) {
      await sql.query(
        `update creator_payment_intents set status='failed' where id=$1 and status='pending'`,
        [id],
      );
    },
    async confirm(id: string, proofKey: string, confirmations: number): Promise<boolean> {
      try {
        const rows = await sql.query<{ id: string }>(
          `with target as (
          select p.id,p.message_id from creator_payment_intents p
          join creator_messages m on m.id=p.message_id and m.payment_id=p.id
            and m.payment_status='pending' and m.recipient_id=p.recipient_id
            and m.sender_id is not distinct from p.sender_id and m.kind=p.kind
          where p.id=$1 and p.status='pending' for update of p,m
        ), claimed as (
          insert into creator_payment_proofs(proof_key,intent_id) select $2,id from target
          on conflict(proof_key) do nothing returning intent_id
        ), paid as (
          update creator_payment_intents set status='paid',paid_at=now(),confirmations=$3
          where id in(select intent_id from claimed) returning id,message_id
        ), delivered as (
          update creator_messages set payment_status='paid',
            last_activity_at=greatest(last_activity_at,clock_timestamp())
          where id in(select message_id from paid) and payment_id=$1 and payment_status='pending'
          returning id
        ) select id from paid`,
          [id, proofKey, confirmations],
        );
        if (rows.length) return true;
        const intent = (
          await sql.query<{ status: string }>(
            `select status from creator_payment_intents where id=$1`,
            [id],
          )
        )[0];
        if (intent?.status === "paid") return true;
        throw new PaymentProofConflictError("This payment proof has already been used.");
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "23505")
          throw new PaymentProofConflictError("This payment proof has already been used.");
        throw error;
      }
    },
    async credential(userId: string): Promise<StoredPaymentCredential | null> {
      return (
        (
          await sql.query<StoredPaymentCredential>(
            `select id,user_id as "userId",encrypted,active from creator_payment_credentials where user_id=$1 and active=true`,
            [userId],
          )
        )[0] ?? null
      );
    },
    async credentialById(id: string): Promise<StoredPaymentCredential | null> {
      return (
        (
          await sql.query<StoredPaymentCredential>(
            `select id,user_id as "userId",encrypted,active from creator_payment_credentials where id=$1`,
            [id],
          )
        )[0] ?? null
      );
    },
    async saveCredential(input: StoredPaymentCredential) {
      // Referencing previous forces old keys inactive before the partial unique
      // index is checked. Unreferenced modifying CTEs have no execution order.
      for (let attempt = 0; ; attempt++) {
        try {
          await sql.query(
            `with previous as (
              update creator_payment_credentials set active=false where user_id=$2 and active=true returning id
            ) insert into creator_payment_credentials(id,user_id,encrypted,active)
              select $1,$2,$3,true from (select count(*) from previous) completed`,
            [input.id, input.userId, input.encrypted],
          );
          return;
        } catch (error) {
          // A competing rotation can publish a new active version after this
          // statement's snapshot. Retry with a fresh snapshot; old versions stay intact.
          if (
            attempt < 2 &&
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "23505" &&
            "constraint" in error &&
            error.constraint === "creator_payment_credentials_active"
          )
            continue;
          throw error;
        }
      }
    },
    async disableCredentials(userId: string) {
      await sql.query(
        `update creator_payment_credentials set active=false where user_id=$1 and active=true`,
        [userId],
      );
    },
    async consumeLimit(key: string, seconds: number, max: number) {
      const rows = await sql.query<{ count: number }>(
        `insert into creator_payment_limits(key,count,window_started_at) values($1,1,now())
       on conflict(key) do update set
       count=case when creator_payment_limits.window_started_at < now()-($2 * interval '1 second') then 1 else creator_payment_limits.count+1 end,
       window_started_at=case when creator_payment_limits.window_started_at < now()-($2 * interval '1 second') then now() else creator_payment_limits.window_started_at end
       where creator_payment_limits.count < $3 or creator_payment_limits.window_started_at < now()-($2 * interval '1 second') returning count`,
        [key, seconds, max],
      );
      return rows.length === 1;
    },
  };
}
export type PaymentStore = ReturnType<typeof createSqlPaymentStore>;
