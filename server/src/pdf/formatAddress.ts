/**
 * The single place address components are joined into the one formatted
 * line the Jinja2 template prints (principal_address, mailing_address,
 * registered_agent_florida_address, and each authorized person's
 * address). Do not reimplement this in the frontend or the Worker —
 * import from here, or port this exact logic, if either ever needs it.
 *
 * Plain text only, no markup: render_pdf.py's Jinja2 Environment is
 * constructed with autoescape=True and the template prints these values
 * with plain `{{ }}` (no `|safe`), so any HTML this function emitted
 * (e.g. "<br>" for a line break) would come out as literal escaped text
 * in the PDF, not a line break.
 */
export interface AddressParts {
  street: string;
  /** Suite/unit — only ever populated for the registered agent address
   *  today (agent_unit). Principal/mailing addresses have no separate
   *  unit field in the current intake form; fold it into `street` if
   *  that ever changes. */
  unit?: string;
  city: string;
  state: string;
  zip: string;
  /** Omitted from the output when unset or "United States" — every
   *  address in this filing is domestic by definition (a Florida LLC's
   *  principal/mailing/agent addresses), so surfacing the country only
   *  when it's something else avoids "United States" clutter. */
  country?: string;
}

export function formatAddress(parts: AddressParts): string {
  const line1 = parts.unit && parts.unit.trim() ? `${parts.street}, ${parts.unit}` : parts.street;
  const cityStateZip = `${parts.city}, ${parts.state} ${parts.zip}`;
  const segments = [line1, cityStateZip];
  const country = parts.country?.trim();
  if (country && country.toLowerCase() !== "united states") {
    segments.push(country);
  }
  return segments.join(", ");
}
