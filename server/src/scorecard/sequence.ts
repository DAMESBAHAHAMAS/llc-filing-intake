/**
 * The five Scorecard emails (SA4-T38). Copy is final text from the
 * "Scorecard Funnel: Final Copy and Build Spec" doc; do not reword here.
 * Each email has one action. Premium and EIN Express are deliberately absent.
 */
export interface SequenceLinks {
  pdf: string;
  checklist: string;
  booking: string;
  packages: string;
  /** Card-hold checkout live in production: Email 4 carries the payment paragraph. */
  payAfterFiling: boolean;
}

export type Block =
  | { t: "p"; text: string }
  | { t: "ol"; items: string[] }
  | { t: "ul"; items: string[] };

export interface BuiltEmail {
  subject: string;
  preview: string;
  blocks: Block[];
  button: { label: string; url: string };
}

/** Days after sign-up each step is sent. */
export const STEP_OFFSET_DAYS: Record<number, number> = { 1: 0, 2: 2, 3: 4, 4: 7, 5: 10 };

export const EMAIL_FOOTER =
  "FileFloridaLLC.com · Damian Knowles Business Advisory · 3850 S University Dr, Unit 291921, Davie, FL 33329. General information, not legal or tax advice.";

export function buildEmail(step: number, links: SequenceLinks): BuiltEmail {
  switch (step) {
    case 1:
      return {
        subject: "Your Florida Business Readiness Scorecard",
        preview: "Score it honestly. Your top three priorities come out of it.",
        blocks: [
          { t: "p", text: `Here's your Scorecard: ${links.pdf}` },
          { t: "p", text: `Before you open it, one rule. Be honest. A 2 means it's done, not "I've thought about it."` },
          { t: "p", text: "How to use it:" },
          {
            t: "ol",
            items: [
              "Score each question 0, 1 or 2.",
              "Add up each section, then your total.",
              "Read your band and your top three priorities.",
              "Write down this week's three actions before you close it.",
            ],
          },
          { t: "p", text: "That last step is the one people skip. Don't." },
          {
            t: "p",
            text: "Over the next ten days I'll send you four short emails. Each one covers a mistake founders make before they file, and how to avoid it.",
          },
          { t: "p", text: "Damian Knowles\nFileFloridaLLC.com" },
        ],
        button: { label: "Open my Scorecard", url: links.pdf },
      };
    case 2:
      return {
        subject: "The order matters more than the paperwork",
        preview: "Plus the full formation checklist, free.",
        blocks: [
          { t: "p", text: "Most setup problems aren't a missing step. They're steps done in the wrong order." },
          {
            t: "p",
            text: "Here's one that costs real money. A founder checks Sunbiz, sees the name is available, and files. Six months later a trademark owner shows up. New name, new filing, new website, new everything.",
          },
          { t: "p", text: "Sunbiz availability is not trademark protection. Check both before you file." },
          {
            t: "p",
            text: `That is one of 36 items in the Complete U.S. LLC Formation Checklist for Foreign Founders. It puts every step in order, from choosing your name to opening your U.S. bank account, in 10 phases. It's yours: ${links.checklist}`,
          },
          {
            t: "p",
            text: "Use the two together. The Scorecard tells you where you stand. The Checklist tells you the order to fix it in.",
          },
          { t: "p", text: "One rule: follow the phases in order. Each phase earns the next." },
          { t: "p", text: "Damian" },
        ],
        button: { label: "Get the Checklist", url: links.checklist },
      };
    case 3:
      return {
        subject: "Don't file yet if you can't answer this",
        preview: "An LLC doesn't create customers. It creates obligations.",
        blocks: [
          {
            t: "p",
            text: "Here's the question I ask before I help anyone file: who is going to pay you, and how do you know?",
          },
          { t: "p", text: `If the honest answer is "I think people will want it," stop. Do not file yet.` },
          {
            t: "p",
            text: "An LLC doesn't create customers. It creates obligations: a state filing, an annual report every year, a registered agent, and a bank account that needs real activity to make sense.",
          },
          { t: "p", text: "Test it first:" },
          {
            t: "ol",
            items: [
              "Write down who your customer is, in one sentence.",
              "Talk to ten of them this week.",
              "Get one to commit: a deposit, a signed quote, a purchase order.",
            ],
          },
          {
            t: "p",
            text: "One real commitment tells you more than a 30-page business plan. Get it, then file. Don't get it, and you just saved yourself a year of paperwork for a business that isn't there yet.",
          },
          {
            t: "p",
            text: "Now look at your Scorecard's Marketing and Sales section. If it scored 0 or 1, that is your first priority. Not the filing.",
          },
          { t: "p", text: "Damian" },
        ],
        button: { label: "Reopen my Scorecard", url: links.pdf },
      };
    case 4: {
      const blocks: Block[] = [
        {
          t: "p",
          text: "If your Scorecard says Ready to Move Forward or Almost Ready, here's how I can take it from here.",
        },
        {
          t: "ul",
          items: [
            "DIY — $139. The Florida state fee, your Certificate of Status and processing. You give us the details; we file your Articles with Sunbiz.",
            "FastTrack — $499. Everything in DIY, plus three years of registered agent service, a domain name, professional email, a single-page website and 500 business cards.",
          ],
        },
      ];
      if (links.payAfterFiling) {
        blocks.push({
          t: "p",
          text: "How payment works: your card is held at checkout, not charged. We charge it only after your LLC is filed and we send you the proof.",
        });
      }
      blocks.push(
        {
          t: "p",
          text: "We submit your filing the same day we receive your complete details. Sunbiz then processes it on its own timeline.",
        },
        { t: "p", text: "Not sure which one fits? The packages page has a free formation review too." },
        { t: "p", text: "Damian" }
      );
      return {
        subject: "When you're ready to file",
        preview: links.payAfterFiling
          ? "Two ways to file, and you pay only after it's filed."
          : "Two ways to file.",
        blocks,
        button: { label: "See the packages", url: links.packages },
      };
    }
    case 5:
      return {
        subject: `"Not yet" is a fine answer`,
        preview: "Rescore in 30 days. Here's why.",
        blocks: [
          { t: "p", text: "Last email in this series." },
          {
            t: "p",
            text: "If your Scorecard came back Needs Attention or Start Here, good. That's not failure. That's the Scorecard doing its job before you spent money.",
          },
          {
            t: "p",
            text: "Put a date in your calendar 30 days from today. Score yourself again. If your top three priorities moved, you're making progress. If they didn't, you just found out what's really in the way.",
          },
          {
            t: "p",
            text: `If you're close and want a straight answer on whether to file now, book a free 15-minute formation review. Bring your score. I'll tell you what I'd do in your position, including "not yet" if that's the answer.`,
          },
          {
            t: "p",
            text: "I want you to win. I'm just not going to help you spend money pretending you already have a business before you've proven demand.",
          },
          { t: "p", text: "Damian" },
        ],
        button: { label: "Book a free formation review", url: links.booking },
      };
    default:
      throw new Error(`unknown scorecard email step ${step}`);
  }
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const linkify = (s: string) =>
  esc(s).replace(/(https?:\/\/[^\s<]+)/g, (u) => `<a href="${u}" style="color:#006BB3">${u}</a>`);

export function renderEmail(
  step: number,
  firstName: string,
  links: SequenceLinks,
  unsubscribeUrl: string
): { subject: string; html: string; text: string } {
  const e = buildEmail(step, links);
  const greeting = `Hi ${firstName},`;

  const html = `<!doctype html><html><body style="margin:0;background:#F7F9FC;font-family:Roboto,Arial,sans-serif;color:#0A1F33">
<span style="display:none;max-height:0;overflow:hidden">${esc(e.preview)}</span>
<div style="max-width:600px;margin:0 auto;padding:24px;background:#FFFFFF;line-height:1.6;font-size:16px">
<p>${esc(greeting)}</p>
${e.blocks
  .map((b) =>
    b.t === "p"
      ? `<p>${linkify(b.text).replace(/\n/g, "<br>")}</p>`
      : b.t === "ol"
        ? `<ol>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ol>`
        : `<ul>${b.items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
  )
  .join("\n")}
<p style="margin:28px 0"><a href="${e.button.url}" style="background:#0092D6;color:#FFFFFF;padding:14px 26px;text-decoration:none;border-radius:8px;font-weight:700;display:inline-block">${esc(e.button.label)}</a></p>
<hr style="border:0;border-top:1px solid #D9E2EC">
<p style="font-size:12px;color:#0A1F33">${esc(EMAIL_FOOTER)} <a href="${unsubscribeUrl}" style="color:#006BB3">Unsubscribe</a>.</p>
</div></body></html>`;

  const text = [
    greeting,
    "",
    ...e.blocks.flatMap((b) =>
      b.t === "p"
        ? [b.text, ""]
        : b.t === "ol"
          ? [...b.items.map((i, n) => `${n + 1}. ${i}`), ""]
          : [...b.items.map((i) => `- ${i}`), ""]
    ),
    `${e.button.label}: ${e.button.url}`,
    "",
    `${EMAIL_FOOTER} Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  return { subject: e.subject, html, text };
}
