import { setting, type Address, type PluginContext, type RateQuote, type ShippingProviderDefinition } from "@spindlecommerce/plugin-sdk";

const API = "https://api.goshippo.com";
/** Below the platform's 10-second limit for rates, so a slow answer fails here with a clear message. */
const RATE_TIMEOUT_MS = 9_000;
const LABEL_TIMEOUT_MS = 20_000;

export const shippoSettings = {
  apiToken: setting.secret({
    label: "API token",
    description: "Shippo › Settings › API. A test token (shippo_test_…) quotes real rates and buys free sample labels.",
    required: true,
    env: "SHIPPO_API_TOKEN",
  }),
  parcelLength: setting.number({ label: "Parcel length (cm)", description: "Products only have weights, so each shipment is quoted as one parcel of this size.", default: 30, min: 1, max: 300 }),
  parcelWidth: setting.number({ label: "Parcel width (cm)", default: 20, min: 1, max: 300 }),
  parcelHeight: setting.number({ label: "Parcel height (cm)", default: 10, min: 1, max: 300 }),
  labelFileType: setting.select({
    label: "Label format",
    options: [
      { value: "PDF", label: "PDF, letter or A4 sheet" },
      { value: "PDF_4x6", label: "PDF, 4×6 in label" },
      { value: "ZPLII", label: "ZPL II, thermal printers" },
    ],
    default: "PDF_4x6",
  }),
  originName: setting.string({
    label: "Ship-from name",
    description: "The ship-from address below replaces the channel's stock location address when its street is set, e.g. when locations have no full address.",
  }),
  originStreet: setting.string({ label: "Ship-from street" }),
  originCity: setting.string({ label: "Ship-from city" }),
  originState: setting.string({ label: "Ship-from state or region", placeholder: "CA" }),
  originPostalCode: setting.string({ label: "Ship-from postal code" }),
  originCountry: setting.string({ label: "Ship-from country", description: "Two-letter code.", placeholder: "US" }),
  originPhone: setting.string({ label: "Ship-from phone", description: "Several carriers require one on labels." }),
  originEmail: setting.string({ label: "Ship-from email" }),
};

export type ShippoSettings = typeof shippoSettings;
type ShippoContext = Pick<PluginContext<ShippoSettings>, "settings" | "fetch">;

export const shippoMethodOptions = {
  carriers: setting.string({
    label: "Carriers",
    description: "Comma-separated, as Shippo names them, e.g. USPS, UPS. Empty offers every carrier connected to the Shippo account.",
    placeholder: "USPS, UPS",
  }),
  serviceLevels: setting.string({
    label: "Service levels",
    description: "Comma-separated Shippo service level tokens, e.g. usps_priority, ups_ground. Empty offers all.",
    placeholder: "usps_priority, ups_ground",
  }),
  markupPercent: setting.number({ label: "Markup (%)", description: "Added to the carrier's price.", default: 0, min: 0, max: 1000 }),
  handlingFee: setting.number({ label: "Handling fee", description: "Added to every rate, in minor units of the cart's currency (150 is 1.50).", default: 0, min: 0, integer: true }),
};

// ---------------------------------------------------------------- Shippo's API

type ShippoAddress = { name?: string; company?: string; street1?: string; street2?: string; city?: string; state?: string; zip?: string; country?: string; phone?: string; email?: string };
type ShippoMessage = { source?: string; code?: string; text?: string };
export type ShippoRate = {
  object_id: string;
  amount: string;
  currency: string;
  provider: string;
  servicelevel: { name: string; token: string };
  estimated_days?: number | null;
};
type ShippoShipment = { object_id: string; status: string; rates?: ShippoRate[]; messages?: ShippoMessage[] };
type ShippoTransaction = {
  object_id: string;
  status: "SUCCESS" | "ERROR" | "QUEUED" | "WAITING" | string;
  tracking_number?: string | null;
  tracking_url_provider?: string | null;
  label_url?: string | null;
  messages?: ShippoMessage[];
  test?: boolean;
};

export class ShippoError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const describeMessages = (messages: ShippoMessage[] | undefined) => (messages ?? []).map((m) => m.text).filter(Boolean).join("; ");

/** Shippo answers errors as `{ detail }` or as messages by field. */
const describeError = (body: unknown): string | null => {
  if (!body || typeof body !== "object") return null;
  if ("detail" in body && typeof body.detail === "string") return body.detail;
  const parts = Object.entries(body).map(([field, value]) => `${field}: ${Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : JSON.stringify(value)}`);
  return parts.length ? parts.join("; ") : null;
};

export const shippoRequest = async <T>(ctx: ShippoContext, method: "GET" | "POST", path: string, body?: unknown, timeoutMs = RATE_TIMEOUT_MS): Promise<T> => {
  const response = await ctx.fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `ShippoToken ${ctx.settings.apiToken}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: an outage page or a proxy's answer.
  }
  if (!response.ok) throw new ShippoError(response.status, `Shippo answered ${response.status}: ${describeError(json) ?? (text.slice(0, 200) || response.statusText)}`);
  return json as T;
};

// ---------------------------------------------------------------- mapping

const compact = <T extends Record<string, unknown>>(record: T) => Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;

const toShippoAddress = (address: Partial<Address>): ShippoAddress =>
  compact({
    name: [address.firstName, address.lastName].filter(Boolean).join(" ") || address.company || undefined,
    company: address.company ?? undefined,
    street1: address.line1,
    street2: address.line2 ?? undefined,
    city: address.city,
    state: address.regionCode ?? address.region ?? undefined,
    zip: address.postalCode,
    country: address.countryCode,
    phone: address.phone ?? undefined,
  });

/** The settings' ship-from address when its street is set, else the location's (with the settings' name, phone and email). */
export const originAddress = (settings: ShippoContext["settings"], origin: Partial<Address> | null): ShippoAddress => {
  const contact = compact({ phone: settings.originPhone, email: settings.originEmail });
  if (settings.originStreet) {
    return compact({
      name: settings.originName,
      street1: settings.originStreet,
      city: settings.originCity,
      state: settings.originState,
      zip: settings.originPostalCode,
      country: settings.originCountry?.trim().toUpperCase(),
      ...contact,
    });
  }
  if (!origin?.countryCode) throw new Error("No ship-from address: give the channel's stock location an address, or set one in the Shippo plugin's settings");
  const address = toShippoAddress(origin);
  return { ...address, ...contact, ...(settings.originName ? { name: settings.originName } : {}) };
};

const parcel = (settings: ShippoContext["settings"], weightGrams: number) => ({
  length: String(settings.parcelLength),
  width: String(settings.parcelWidth),
  height: String(settings.parcelHeight),
  distance_unit: "cm",
  // Carriers refuse weightless parcels; products without a weight count as nothing.
  weight: String(Math.max(1, Math.round(weightGrams))),
  mass_unit: "g",
});

const quoteShipment = (ctx: ShippoContext, from: ShippoAddress, to: ShippoAddress, weightGrams: number, timeoutMs = RATE_TIMEOUT_MS) =>
  shippoRequest<ShippoShipment>(ctx, "POST", "/shipments/", { address_from: from, address_to: to, parcels: [parcel(ctx.settings, weightGrams)], async: false }, timeoutMs);

/**
 * Minor units per currency, as the platform stores amounts (Ecom's src/lib/money.ts): ISO 4217's
 * exponents, 2 for any currency not listed. Intl's currency digits differ for some (HUF, IDR, COP
 * and IQD, say), so they would be wrong here.
 */
const EXPONENTS: Record<string, number> = {
  BHD: 3, BIF: 0, CLP: 0, DJF: 0, GNF: 0, IQD: 3, ISK: 0, JOD: 3, JPY: 0, KMF: 0, KRW: 0,
  KWD: 3, LYD: 3, OMR: 3, PYG: 0, RWF: 0, TND: 3, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};
/** "5.50" USD → 550, "1500" HUF → 150000. */
export const toMinorUnits = (amount: string, currency: string) => Math.round(Number(amount) * 10 ** (EXPONENTS[currency.toUpperCase()] ?? 2));

const list = (value: unknown) => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);
const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

/** A method's options, read defensively: they were checked when saved, but plugins change. */
const methodOptions = (options: Record<string, unknown>) => ({
  carriers: list(options.carriers).map(normalize),
  serviceLevels: list(options.serviceLevels).map((s) => s.toLowerCase()),
  markupPercent: typeof options.markupPercent === "number" ? options.markupPercent : 0,
  handlingFee: typeof options.handlingFee === "number" ? Math.round(options.handlingFee) : 0,
});

const offered = (rate: ShippoRate, options: ReturnType<typeof methodOptions>) =>
  (options.carriers.length === 0 || options.carriers.includes(normalize(rate.provider))) && (options.serviceLevels.length === 0 || options.serviceLevels.includes(rate.servicelevel.token.toLowerCase()));

/** Stable across quotes, so a customer's choice survives re-quoting: `usps:usps_priority`. */
export const rateCode = (rate: Pick<ShippoRate, "provider" | "servicelevel">) => `${slug(rate.provider)}:${rate.servicelevel.token}`;

const rateName = (rate: ShippoRate) => (normalize(rate.servicelevel.name).startsWith(normalize(rate.provider)) ? rate.servicelevel.name : `${rate.provider} ${rate.servicelevel.name}`);

const TRACKING_PAGES: Record<string, (number: string) => string> = {
  usps: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`,
  ups: (n) => `https://www.ups.com/track?tracknum=${n}`,
  fedex: (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  dhl: (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}&submit=1`,
  dhlexpress: (n) => `https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id=${n}`,
  canadapost: (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`,
  royalmail: (n) => `https://www.royalmail.com/track-your-item#/tracking-results/${n}`,
  australiapost: (n) => `https://auspost.com.au/mypost/track/details/${n}`,
};

export const trackingUrl = ({ carrier, number }: { carrier: string; number: string }) => TRACKING_PAGES[normalize(carrier)]?.(encodeURIComponent(number)) ?? null;

// ---------------------------------------------------------------- provider

export const shippoProvider: ShippingProviderDefinition<ShippoSettings> = {
  code: "shippo",
  title: "Shippo",
  description: "Live rates from the carriers connected to your Shippo account, and labels when you fulfil.",
  methodOptions: shippoMethodOptions,

  async rates(input, ctx) {
    const options = methodOptions(input.method.options);
    const shipment = await quoteShipment(ctx, originAddress(ctx.settings, input.origin), toShippoAddress(input.destination), input.weightGrams);
    if (!shipment.rates?.length && shipment.messages?.length) ctx.logger.warn({ messages: shipment.messages }, `Shippo offered no rates: ${describeMessages(shipment.messages)}`);
    // Rates in the cart's currency only: there is no currency conversion.
    const cheapest = new Map<string, RateQuote>();
    for (const rate of shipment.rates ?? []) {
      if (rate.currency !== input.currency || !offered(rate, options)) continue;
      const amount = Math.round(toMinorUnits(rate.amount, rate.currency) * (1 + options.markupPercent / 100)) + options.handlingFee;
      const code = rateCode(rate);
      if ((cheapest.get(code)?.amount ?? Number.POSITIVE_INFINITY) <= amount) continue;
      const days = rate.estimated_days ?? null;
      cheapest.set(code, {
        code,
        name: rateName(rate),
        amount,
        carrier: rate.provider,
        minDeliveryDays: days,
        maxDeliveryDays: days,
        data: { rateId: rate.object_id, provider: rate.provider, servicelevel: rate.servicelevel.token },
      });
    }
    return [...cheapest.values()].sort((a, b) => a.amount - b.amount);
  },

  /**
   * Re-quotes the shipment as packed (the units being shipped, the default parcel) and buys the
   * label for the service the customer chose, or the cheapest when the order did not use Shippo.
   */
  async createShipment(input, ctx) {
    const destination = input.order.shippingAddress;
    if (!destination) throw new Error("The order has no shipping address");
    const weight = input.lines.reduce((sum, l) => sum + (l.weightGrams ?? 0) * l.quantity, 0);
    const shipment = await quoteShipment(ctx, originAddress(ctx.settings, input.origin), { ...toShippoAddress(destination), email: input.order.email }, weight, LABEL_TIMEOUT_MS);
    const wanted = typeof input.rate?.data.servicelevel === "string" ? input.rate.data.servicelevel : null;
    const options = methodOptions(input.method?.options ?? {});
    const candidates = (shipment.rates ?? []).filter((r) => (wanted ? r.servicelevel.token === wanted : offered(r, options))).sort((a, b) => Number(a.amount) - Number(b.amount));
    const rate = candidates[0];
    if (!rate) {
      const why = describeMessages(shipment.messages);
      throw new Error(wanted ? `Shippo offers no ${wanted} rate for this shipment now${why ? ` (${why})` : ""}; buy the label in Shippo or ship without one` : `Shippo offered no rates for this shipment${why ? `: ${why}` : ""}`);
    }
    const transaction = await shippoRequest<ShippoTransaction>(ctx, "POST", "/transactions/", { rate: rate.object_id, label_file_type: ctx.settings.labelFileType, async: false }, LABEL_TIMEOUT_MS);
    if (transaction.status !== "SUCCESS") throw new Error(`the label was not created (${describeMessages(transaction.messages) || transaction.status})`);
    return {
      tracking: transaction.tracking_number
        ? [{ carrier: rate.provider, number: transaction.tracking_number, url: transaction.tracking_url_provider || trackingUrl({ carrier: rate.provider, number: transaction.tracking_number }) }]
        : [],
      labelUrl: transaction.label_url ?? null,
      cost: { amount: toMinorUnits(rate.amount, rate.currency), currency: rate.currency },
      data: { transactionId: transaction.object_id, rateId: rate.object_id, shipmentId: shipment.object_id, provider: rate.provider, servicelevel: rate.servicelevel.token, test: transaction.test ?? null },
    };
  },

  trackingUrl,
};

/** "Test connection": the token works if Shippo lists its carrier accounts. */
export const checkConnection = async (ctx: ShippoContext): Promise<{ ok: boolean; message: string }> => {
  const test = ctx.settings.apiToken.startsWith("shippo_test_");
  try {
    const accounts = await shippoRequest<{ results?: { carrier: string; active?: boolean }[] }>(ctx, "GET", "/carrier_accounts/?results=100");
    const carriers = [...new Set((accounts.results ?? []).filter((a) => a.active !== false).map((a) => a.carrier))];
    const mode = test ? "Connected with a test token: rates are real, labels are free samples." : "Connected with a live token: labels are charged to the Shippo account.";
    return { ok: true, message: `${mode} ${carriers.length ? `Carriers: ${carriers.join(", ")}.` : "No active carrier accounts yet: connect one in Shippo."}` };
  } catch (error) {
    if (error instanceof ShippoError && (error.status === 401 || error.status === 403)) return { ok: false, message: "Shippo rejected the API token." };
    return { ok: false, message: `Could not reach Shippo: ${error instanceof Error ? error.message : String(error)}` };
  }
};
