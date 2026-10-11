import { ApiError, CloudError, Security, SmartHomeCloud } from "midea-local";

/** The SmartHome (MSmartHome) app sign-in of whoever owns the unit. */
export interface Credentials {
  account: string;
  password: string;
}

/**
 * Thrown when pairing cannot continue without the owner's SmartHome sign-in,
 * or when Midea turned that sign-in down. `message` is written for the user.
 */
export class NeedsAccountError extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "NeedsAccountError";
  }
}

/** A unit's ID as the six bytes Midea hashes, in either byte order. */
function idBytes(deviceId: number, order: "little" | "big"): Buffer {
  const buf = Buffer.alloc(6);
  if (order === "little") buf.writeUIntLE(deviceId, 0, 6);
  else buf.writeUIntBE(deviceId, 0, 6);
  return buf;
}

function explain(e: unknown): Error {
  if (e instanceof ApiError) {
    if (e.code === 3102) {
      return new NeedsAccountError(
        "Midea has no SmartHome account with that email, or the password is wrong.",
      );
    }
    if (e.code === 3201) {
      return new NeedsAccountError(
        "That account does not own this air conditioner. Sign in with the account it is paired to in the SmartHome app.",
      );
    }
    return new NeedsAccountError(`Midea's cloud refused: ${e.message} (code ${e.code}).`);
  }
  if (e instanceof CloudError) {
    return new Error("Could not reach Midea's cloud. Check this Mac's internet connection and try again.");
  }
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Ask Midea's cloud for the token and key that unlock local control of one unit.
 *
 * Until 2026 the community libraries got these through a shared account on the
 * older NetHome Plus API. Midea closed that door: the token endpoint there now
 * answers "system error" (9999), and the SmartHome API only hands a unit's key
 * to the account that owns it, and only when the request names the unit
 * (`applianceCodes`). See mill1000/midea-ac-py#482.
 *
 * Yields one candidate per byte order of the unit's ID; the caller tries each
 * against the unit and keeps the one it accepts. The password is used for this
 * one sign-in and is not kept anywhere.
 */
export async function* lanKeys(
  deviceId: number,
  credentials: Credentials,
): AsyncGenerator<{ token: string; key: string }> {
  const cloud = new SmartHomeCloud(undefined, credentials);
  // The library's own getToken() predates the applianceCodes requirement, so
  // build that one request here with its (protected) helpers.
  const api = cloud as unknown as {
    _apiRequest(endpoint: string, body: Record<string, unknown>): Promise<Record<string, unknown> | null>;
    _buildRequestBody(data: Record<string, unknown>): Record<string, unknown>;
  };

  try {
    await cloud.login();
  } catch (e) {
    throw explain(e);
  }

  for (const order of ["little", "big"] as const) {
    const udpid = Security.udpid(idBytes(deviceId, order)).toString("hex");
    let response: Record<string, unknown> | null;
    try {
      response = await api._apiRequest(
        "/v1/iot/secure/getToken",
        api._buildRequestBody({ udpid, applianceCodes: String(deviceId) }),
      );
    } catch (e) {
      throw explain(e);
    }
    const list = (response?.["tokenlist"] ?? []) as { udpId?: string; token?: string; key?: string }[];
    const match = list.find((t) => t.udpId === udpid);
    if (match?.token && match.key) yield { token: match.token, key: match.key };
  }
}
