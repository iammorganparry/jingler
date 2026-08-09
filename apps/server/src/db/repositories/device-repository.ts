import type {
  DeviceEnrollmentCredential,
  DeviceRecord,
  PendingDeviceRegistrationRequest
} from "@jingler/core"
import { and, asc, eq, gt, isNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import { Database, type DatabaseError } from "../database.js"
import { deviceEnrollment, ownedDevice } from "../schema.js"

export type DeviceEnrollmentResult =
  | { readonly status: "registered"; readonly device: DeviceRecord }
  | { readonly status: "expired" | "replayed" | "claim-mismatch" | "revoked" }

const epoch = (value: Date): number => Math.floor(value.getTime() / 1_000)

const parse = <A>(value: string): A => JSON.parse(value) as A

const toRecord = (row: typeof ownedDevice.$inferSelect): DeviceRecord => ({
  version: 1,
  deviceId: row.id,
  accountId: row.userId,
  identityFingerprint: row.identityFingerprint,
  displayName: row.displayName,
  platform: parse(row.platform),
  publicKey: parse(row.publicKey),
  ...(row.encryptionPublicKey
    ? { encryptionPublicKey: parse(row.encryptionPublicKey) }
    : {}),
  capabilities: parse(row.capabilities),
  agentVersion: row.agentVersion,
  state: row.state === "revoked" ? "revoked" : "active",
  generation: row.generation,
  enrolledAt: epoch(row.enrolledAt),
  createdAt: epoch(row.createdAt),
  updatedAt: epoch(row.updatedAt),
  revokedAt: row.revokedAt ? epoch(row.revokedAt) : null
})

const repositoryFor = (database: Database) => ({
  createEnrollment: (
    credential: DeviceEnrollmentCredential
  ): Effect.Effect<void, DatabaseError> =>
    database
      .run("DeviceRepository.createEnrollment", (db) =>
        db
          .insert(deviceEnrollment)
          .values({
            id: credential.claimId,
            userId: credential.subject,
            deviceId: credential.deviceId,
            clientInstanceId: credential.clientInstanceId,
            expiresAt: new Date(credential.expiresAt * 1_000),
            consumedAt: null,
            identityFingerprint: null,
            createdAt: new Date(credential.issuedAt * 1_000)
          })
          .onConflictDoNothing()
      )
      .pipe(Effect.asVoid),

  consumeAndUpsert: (input: {
    readonly credential: DeviceEnrollmentCredential
    readonly identityFingerprint: string
    readonly registration: PendingDeviceRegistrationRequest
    readonly at: Date
  }): Effect.Effect<DeviceEnrollmentResult, DatabaseError> =>
    database.run("DeviceRepository.consumeAndUpsert", (db) =>
      db.transaction(async (tx) => {
        const consumed = await tx
          .update(deviceEnrollment)
          .set({
            consumedAt: input.at,
            identityFingerprint: input.identityFingerprint
          })
          .where(
            and(
              eq(deviceEnrollment.id, input.credential.claimId),
              eq(deviceEnrollment.userId, input.credential.subject),
              eq(deviceEnrollment.deviceId, input.credential.deviceId),
              eq(
                deviceEnrollment.clientInstanceId,
                input.credential.clientInstanceId
              ),
              isNull(deviceEnrollment.consumedAt),
              gt(deviceEnrollment.expiresAt, input.at)
            )
          )
          .returning()
        if (!consumed[0]) {
          const rows = await tx
            .select()
            .from(deviceEnrollment)
            .where(eq(deviceEnrollment.id, input.credential.claimId))
            .limit(1)
          const row = rows[0]
          if (!row) return { status: "claim-mismatch" } as const
          if (
            row.userId !== input.credential.subject ||
            row.deviceId !== input.credential.deviceId ||
            row.clientInstanceId !== input.credential.clientInstanceId
          ) {
            return { status: "claim-mismatch" } as const
          }
          if (row.expiresAt <= input.at) return { status: "expired" } as const
          if (row.identityFingerprint === input.identityFingerprint) {
            const devices = await tx
              .select()
              .from(ownedDevice)
              .where(
                and(
                  eq(ownedDevice.userId, input.credential.subject),
                  eq(ownedDevice.identityFingerprint, input.identityFingerprint)
                )
              )
              .limit(1)
            const device = devices[0]
            if (device) {
              return device.state === "revoked"
                ? ({ status: "revoked" } as const)
                : ({ status: "registered", device: toRecord(device) } as const)
            }
          }
          return { status: "replayed" } as const
        }

        const values = {
          id: input.credential.deviceId,
          userId: input.credential.subject,
          identityFingerprint: input.identityFingerprint,
          displayName: input.registration.displayName,
          platform: JSON.stringify(input.registration.platform),
          publicKey: JSON.stringify(input.registration.publicKey),
          encryptionPublicKey: input.registration.encryptionPublicKey
            ? JSON.stringify(input.registration.encryptionPublicKey)
            : null,
          capabilities: JSON.stringify(input.registration.capabilities),
          agentVersion: input.registration.agentVersion ?? null,
          state: "active",
          generation: 1,
          enrolledAt: input.at,
          revokedAt: null,
          createdAt: input.at,
          updatedAt: input.at
        } as const
        const rows = await tx
          .insert(ownedDevice)
          .values(values)
          .onConflictDoUpdate({
            target: [ownedDevice.userId, ownedDevice.identityFingerprint],
            set: {
              displayName: values.displayName,
              platform: values.platform,
              publicKey: values.publicKey,
              encryptionPublicKey: values.encryptionPublicKey,
              capabilities: values.capabilities,
              agentVersion: values.agentVersion,
              updatedAt: input.at
            }
          })
          .returning()
        const device = rows[0]
        if (!device) throw new Error("Device enrollment upsert returned no row")
        return device.state === "revoked"
          ? ({ status: "revoked" } as const)
          : ({ status: "registered", device: toRecord(device) } as const)
      })
    ),

  listForUser: (
    userId: string
  ): Effect.Effect<ReadonlyArray<DeviceRecord>, DatabaseError> =>
    database
      .run("DeviceRepository.listForUser", (db) =>
        db
          .select()
          .from(ownedDevice)
          .where(eq(ownedDevice.userId, userId))
          .orderBy(asc(ownedDevice.createdAt), asc(ownedDevice.id))
      )
      .pipe(Effect.map((rows) => rows.map(toRecord))),

  findForUser: (
    userId: string,
    deviceId: string
  ): Effect.Effect<DeviceRecord | null, DatabaseError> =>
    database
      .run("DeviceRepository.findForUser", (db) =>
        db
          .select()
          .from(ownedDevice)
          .where(and(eq(ownedDevice.userId, userId), eq(ownedDevice.id, deviceId)))
          .limit(1)
      )
      .pipe(Effect.map((rows) => rows[0] ? toRecord(rows[0]) : null)),

  renameForUser: (input: {
    readonly userId: string
    readonly deviceId: string
    readonly displayName: string
    readonly at: Date
  }): Effect.Effect<DeviceRecord | null, DatabaseError> =>
    database
      .run("DeviceRepository.renameForUser", (db) =>
        db
          .update(ownedDevice)
          .set({ displayName: input.displayName, updatedAt: input.at })
          .where(
            and(
              eq(ownedDevice.userId, input.userId),
              eq(ownedDevice.id, input.deviceId),
              eq(ownedDevice.state, "active")
            )
          )
          .returning()
      )
      .pipe(Effect.map((rows) => rows[0] ? toRecord(rows[0]) : null)),

  revokeForUser: (input: {
    readonly userId: string
    readonly deviceId: string
    readonly at: Date
  }): Effect.Effect<DeviceRecord | null, DatabaseError> =>
    database
      .run("DeviceRepository.revokeForUser", (db) =>
        db
          .update(ownedDevice)
          .set({
            state: "revoked",
            revokedAt: input.at,
            generation: sql`${ownedDevice.generation} + 1`,
            updatedAt: input.at
          })
          .where(
            and(
              eq(ownedDevice.userId, input.userId),
              eq(ownedDevice.id, input.deviceId)
            )
          )
          .returning()
      )
      .pipe(Effect.map((rows) => rows[0] ? toRecord(rows[0]) : null))
})

export class DeviceRepository extends Effect.Service<DeviceRepository>()(
  "@jingler/server/DeviceRepository",
  {
    accessors: true,
    effect: Effect.gen(function* () {
      return repositoryFor(yield* Database)
    })
  }
) {}
