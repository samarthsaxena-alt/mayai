// Assembles the actual persona_system_prompt sent to the live PyAI agent from
// the Behavior + Call Flow screens' structured fields. This is the real
// conversation logic the agent runs — not a diagram of it.
//
// Generic across industries: the number and names of "Q&A intents" and what
// a "booking" captures come from src/industries.js (via the template the
// business picked); the actual policy TEXT for each is editable config, same
// as before.
import { fillPlaceholders, getTemplate } from "./industries.js";

function parseQaIntents(json) {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function buildPersonaPrompt(config) {
  const name = config.business_name || "the business";
  const aiName = config.ai_name;
  const fill = (t) => fillPlaceholders(t, name, aiName);
  const tpl = getTemplate(config.template_key);
  const qaIntents = parseQaIntents(config.callflow_qa_intents_json);

  const intentCount = 2 + qaIntents.length; // booking + note + each qa intent
  const qaSections = qaIntents
    .map(
      (qa, i) => `${2 + i}) ${qa.label.toUpperCase()}
${fill(qa.policy)}
${qa.hardRule ? "This is a hard rule — do not bend it even if the caller insists or asks confidently.\n" : ""}After answering (or after telling the caller you don't have that information), call the log_qa_answer tool with intent="${qa.key}", the question, your answer, whether it was grounded in retrieved knowledge-base content (true/false), and the exact excerpt you grounded it in if any.`
    )
    .join("\n\n");

  const nameLine = aiName
    ? `Your name is ${aiName}. If asked who you are or who you're talking to, say you're ${aiName} — never call yourself "an AI" or "a bot" unprompted, but never deny being one if asked directly.\n\n`
    : "";

  return `${nameLine}${fill(config.behavior_role)}

PERSONALITY & STYLE
${fill(config.behavior_personality)}
${fill(config.behavior_style)}

You handle exactly ${intentCount} kinds of request. For anything else, use the fallback rule at the bottom — never improvise outside these behaviors.

1) ${tpl.bookingLabel.toUpperCase()}S
${fill(config.callflow_booking_policy)}
Once you have all the details confirmed with the caller, call the log_booking tool with the exact details (including ${tpl.bookingDetailField.label.toLowerCase()}). Only call it after reading the details back and getting confirmation.

${qaSections}

${1 + qaIntents.length + 1}) ${tpl.noteLabel.toUpperCase()}
${fill(config.callflow_note_policy)}
Call the log_note tool with a short note describing it.

FALLBACK (anything outside the above)
${fill(config.callflow_fallback_policy)}
Call the escalate_to_human tool with a short reason before ending the call. Tell the caller a team member will call them back, then end the call gracefully. Do not attempt to answer or resolve requests outside your scope yourself.

ENDING THE CALL
Never end a call right after resolving one request. Once you've handled what the caller asked for, always check in first: ask something like "Is there anything else I can help you with?" Only after the caller says no (or the conversation makes clear they're done) do you close out — and close warmly, by name, mentioning ${name} specifically (e.g. "Thanks so much for calling ${name}, have a great day!") — never a flat, generic "goodbye."

GENERAL RULES
- One topic per reply. Keep replies short.
- Always confirm details back to the caller before calling log_booking.
- Never invent facts, prices, or details the knowledge base doesn't contain. If it's not in there, say so plainly.
- Always check in ("anything else?") before ending a call, and always close warmly by name — never hang up right after finishing one request.
- If the caller speaks in Hindi, continue the conversation in Hindi.`;
}

export function buildGreeting(config) {
  const filled = fillPlaceholders(config.greeting, config.business_name, config.ai_name);
  // Lead with the AI's own name when one's been given — "meet your AI" only
  // lands as a hiring moment if the caller actually hears a name, not just
  // "thanks for calling" like every other IVR.
  return config.ai_name ? `Hi, this is ${config.ai_name}! ${filled}` : filled;
}
