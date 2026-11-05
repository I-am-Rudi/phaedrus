// The rule set Phaedrus ships with: patterns that make prose read as
// machine-written. Paraphrased and condensed from Wikipedia's "Signs of AI
// writing" (WikiProject AI Cleanup, CC BY-SA 4.0) and the rewriting guides
// built on it. It is seeded into the rules folder on first start and is
// always on until switched off on the Rules page.

import { newRule, type RuleSet, type WritingRule } from '../rules';

export const AI_TELLS_ID = 'signs-of-ai-writing';
const SOURCE = 'Wikipedia: Signs of AI writing (WikiProject AI Cleanup)';

const R = (r: Partial<WritingRule> & { id: string; title: string }): WritingRule =>
  newRule({ origin: 'extracted', source: SOURCE, ...r });

export const AI_TELLS_RULES: WritingRule[] = [
  R({
    id: 'not-x-but-y',
    title: 'No "not X but Y" contrasts for emphasis',
    description:
      'Do not set a point against something nobody claimed ("not just X, but Y", "it is not X, it is Y", "X rather than Y", or the same contrast over two sentences: "This does not mean X. It means Y."). State the point directly. A contrast is fine when the negative half corrects a belief the reader actually holds, or when both halves carry information.',
    good: ['The heavy beat adds to the aggressive tone.', 'The bound is not tight: the example in Section 3 exceeds it by a factor of two.'],
    bad: ["It's not merely a song, it's a statement.", 'This does not mean every choice is equal. It means no external system confirms which one is right.'],
  }),
  R({
    id: 'one-line-closers',
    title: 'No closers that repeat the point, no dramatic fragments',
    description:
      'Do not end a paragraph on a short line that restates it ("That is the real win.", "Let that sink in.") and do not stack fragments for drama ("No prior. No bias. No nostalgia."). A short sentence is fine when it adds a new fact.',
    good: ['AlphaEvolve did not favour symmetric designs, which made some older assumptions less useful.'],
    bad: ['It had no preference for symmetry. No aesthetic prior. No nostalgia. The old rules were gone.', 'Caching cuts repeat work. That is the real win.'],
  }),
  R({
    id: 'deep-sayings',
    title: 'No sayings that only sound deep',
    description:
      'Replace phrases that dress an ordinary point as a hidden truth or an aphorism ("the real question is", "at its core", "what really matters", "the heart of the matter", "X is the language of Y", "X becomes a trap") with the specific claim.',
    good: ['Whether teams can adapt mostly depends on whether the organisation is ready to change its habits.'],
    bad: ['At its core, what really matters is organisational readiness.', 'Symmetry is the language of trust.'],
  }),
  R({
    id: 'staged-run-up',
    title: 'Make the point instead of announcing it',
    description:
      'Cut run-ups that announce or stage the point ("Let\'s dive in", "Let\'s break this down", "Here\'s what you need to know", "Here\'s the thing", a standalone "Honestly?" or "Look,") and open with the point itself.',
    good: ['Next.js caches data at several layers, including request memoisation and the router cache.'],
    bad: ["Let's dive into how caching works. Here's what you need to know.", 'Is it worth it? Honestly? It depends.'],
  }),
  R({
    id: 'arguing-with-no-one',
    title: 'Do not answer objections nobody raised',
    description:
      'Remove defences against claims or options that appear nowhere else in the text ("This isn\'t about X", "I\'m not saying", "To be clear", "One might be tempted to", "A tempting approach would be"). Keep an objection the text attributes or answers in full, and an alternative a reader would really weigh.',
    good: ['The issue is whether the agent can use the instruction when it acts.'],
    bad: ["This isn't mainly about prompt length, and I'm not arguing that documentation doesn't matter."],
  }),
  R({
    id: 'forced-triads',
    title: 'No lists of three for rhythm',
    description:
      'Do not group items, examples or short sentences in threes because three sounds complete. Keep three items when the content has three; otherwise merge them, develop the strongest, or vary the structure. One triad in a paragraph is weak evidence on its own; flag it when the three items overlap or when other tells are present.',
    good: ['The event has talks and panels, with time for informal networking between sessions.'],
    bad: ['Attendees can expect innovation, inspiration, and industry insights.'],
  }),
  R({
    id: 'repeated-openings',
    title: 'Do not open several sentences in a row the same way',
    description:
      'Avoid three or more consecutive sentences that start with the same word or subject ("She noted... She noted... She filed..."). Merge them, change the subject or start with the action. Deliberate repetition for rhythm is fine.',
    good: ['She noted the door and its lock, then filed both away.'],
    bad: ['She noted the door. She noted the lock on it. She filed both away.'],
  }),
  R({
    id: 'dashes',
    title: 'No dashes as an all-purpose connector',
    description:
      'Replace em and en dashes used to join or interrupt clauses with a full stop, comma, colon or parentheses, or rewrite the sentence. This includes spaced hyphens and double hyphens used as dashes.',
    good: ['The new policy, announced without warning, affects thousands of workers.'],
    bad: ['The new policy — announced without warning — affects thousands of workers.'],
    notes: [
      'In LaTeX source "---" is an em dash and counts; "--" between numbers or names (pages 3--7, Einstein--Hilbert action) is a correct en dash and does not.',
      'Hyphens inside compound words, math, code, URLs and labels are not dashes.',
    ],
  }),
  R({
    id: 'stacked-qualifiers',
    title: 'No stacked hedges',
    description:
      'Do not pile qualifiers onto one claim ("could potentially", "might arguably", "it is also possible that in some cases it may"). Keep one qualifier when the evidence calls for doubt and say the claim plainly otherwise. A single ordinary hedge ("perhaps", "tends to") is not a problem.',
    good: ['The policy may affect outcomes.'],
    bad: ['It could potentially possibly be argued that the policy might have some effect on outcomes.'],
    notes: ['Real uncertainty with a reason (an uncontrolled error, an unproven conjecture) is not hedging; keep it.'],
  }),
  R({
    id: 'ai-vocabulary',
    title: 'Avoid words language models overuse',
    description:
      'Replace these with plain words, especially when several appear together: delve, leverage, utilize, foster, bolster, garner, underscore (verb), highlight (verb), showcase, unveil, streamline, enhance, align with, crucial, pivotal, key (adjective), robust (figurative), seamless, comprehensive, intricate, meticulous, vibrant, enduring, valuable, interplay, tapestry, landscape (abstract), testament, realm, additionally.',
    good: ['Somali cuisine also includes camel meat.'],
    bad: ['Additionally, an enduring testament to this is the vibrant culinary landscape, showcasing its intricate interplay.'],
    notes: [
      'Technical senses are fine: a robust estimator, a key in a dictionary, the energy landscape of a potential, the crucial point of a phase diagram.',
      'One word alone is weak evidence; flag clusters, or a word used only for weight.',
    ],
  }),
  R({
    id: 'inflated-significance',
    title: 'Do not inflate the significance of ordinary facts',
    description:
      'Do not say a detail marks a turning point, leaves a legacy or sets the stage ("a pivotal moment", "plays a key role", "reflects a broader trend", "an indelible mark", "the future looks bright", "continues to thrive despite challenges"). Keep the fact and drop the significance; end on the last concrete fact.',
    good: ['The institute was founded in 1989, part of a wider decentralisation of administration in Spain.'],
    bad: ['Its founding in 1989 marked a pivotal moment in the evolution of regional statistics.'],
  }),
  R({
    id: 'vague-association',
    title: 'Name the relationship instead of "associated with"',
    description:
      'Replace vague links ("associated with", "in connection with", "linked to", "tied to") with the actual relationship (founded, leads, was caused by, is a special case of) when the text or its sources give it.',
    good: ['He founded and conducts the orchestra.'],
    bad: ['He is associated with the orchestra.'],
    notes: ['Statistical association and "the operator associated with an observable" are precise uses; keep them.'],
  }),
  R({
    id: 'ing-riders',
    title: 'No -ing phrases that add unsupported meaning',
    description:
      'Do not bolt an -ing phrase onto a fact to make it sound deeper ("..., highlighting its importance", "..., reflecting a deep connection", "..., underscoring the need for", "..., ensuring that"). Keep the fact; keep the phrase only when it states something the text supports.',
    good: ['The temple is painted blue, green and gold, colours meant to evoke the local landscape.'],
    bad: ['The temple is painted blue and gold, symbolizing the landscape and reflecting the community\'s deep connection to the land.'],
  }),
  R({
    id: 'sales-language',
    title: 'No promotional language',
    description:
      'Do not describe things like an advertisement ("boasts", "nestled in the heart of", "rich heritage", "breathtaking", "renowned", "groundbreaking", "a diverse array of", "stunning", "must-visit"). Say what the thing is and what it does.',
    good: ['Alamata is a town in the Raya region of Ethiopia.'],
    bad: ['Nestled in the breathtaking highlands, the vibrant town boasts a rich cultural heritage.'],
  }),
  R({
    id: 'borrowed-authority',
    title: 'Name the source instead of borrowing authority',
    description:
      'Do not lean on unnamed authorities ("experts argue", "observers note", "studies show", "it is widely believed") or on a list of prestigious outlets. Cite who said what, or state the claim on its own evidence.',
    good: ['Smith and Jones (2019) measured the effect at 3 sigma.'],
    bad: ['Experts believe it plays a crucial role in the ecosystem.'],
    notes: ['A missing citation alone is not a tell. Flag only claims that rest on an unnamed authority.'],
  }),
  R({
    id: 'plain-verbs',
    title: 'Use "is" and "has" instead of inflated verbs',
    description:
      'Prefer the plain verb to "serves as", "stands as", "functions as", "represents a", "boasts", "features", "offers" when they only mean is or has.',
    good: ['The gallery is the exhibition space of the institute and has four rooms.'],
    bad: ['The gallery serves as the exhibition space and boasts four separate rooms.'],
    notes: ['"Represents" in the mathematical sense (a matrix represents an operator) is precise; keep it.'],
  }),
  R({
    id: 'filler-openers',
    title: 'No filler openers and transitions',
    description:
      'Cut openers and transitions that add length but no meaning ("In today\'s world", "It is important to note that", "It is worth noting", "When it comes to", "That being said", "Furthermore", "Moreover" at the start of every other sentence). Open on the fact.',
    good: ['Three manufacturers have faced lawsuits over planned obsolescence.'],
    bad: ["In today's world, it is important to note that planned obsolescence affects many devices."],
  }),
  R({
    id: 'empty-intensifiers',
    title: 'Replace intensifiers with the evidence',
    description:
      'Words such as "significantly", "dramatically", "extremely", "incredibly", "truly" and "deeply" stand in for a number or a comparison. Give the number or the comparison, or drop the word.',
    good: ['They charged 1,200 euros for a repair that needed a 5 euro chip.'],
    bad: ['The price was significantly higher than the cost of the part.'],
    notes: ['"Significantly" with a stated statistical test or confidence level is a precise term; keep it.'],
  }),
  R({
    id: 'hollow-claims',
    title: 'End claims on something concrete',
    description:
      'A sentence that asserts importance or impact without a detail says nothing ("This has had a significant impact on the field"). Tie the claim to a result, number, example or reference the reader can check.',
    good: ['The method reduced the variance of the estimator by an order of magnitude on the 4-simplex.'],
    bad: ['This approach has had a profound impact on the field.'],
  }),
  R({
    id: 'chatbot-residue',
    title: 'No chatbot wrappers or knowledge-limit disclaimers',
    description:
      'Remove leftovers of a chat ("Great question!", "Certainly!", "I hope this helps", "Let me know if", "Here is an overview of") and remarks about the limits of knowledge followed by a guess ("while details are limited", "as of my last update", "not widely documented, but likely"). Keep the content they wrap; state plainly what is not known.',
    good: ['The founding date of the company is not documented.'],
    bad: ['Great question! Here is an overview. I hope this helps!', 'While details are limited, it was likely founded in the 1990s.'],
  }),
];

export function aiTellsRuleSet(): RuleSet {
  const now = new Date().toISOString();
  return {
    id: AI_TELLS_ID,
    name: 'Signs of AI writing',
    language: 'en',
    description:
      'Patterns that make prose read as machine-written, after Wikipedia\'s "Signs of AI writing". Ships with Phaedrus and is always on; switch it off on the Rules page or turn off single rules.',
    sources: [{ title: 'Signs of AI writing', author: 'WikiProject AI Cleanup, Wikipedia (CC BY-SA 4.0)' }],
    rules: AI_TELLS_RULES,
    created: now,
    updated: now,
  };
}
