/** One-click demo prompts for Load Example. These reflect how real teams write
 * prompts: repeated instructions, restated constraints, politeness padding —
 * exactly the material PromptPolice compresses while protecting structure. */

export interface SamplePrompt {
  id: string;
  label: string;
  text: string;
}

export const SAMPLE_PROMPTS: SamplePrompt[] = [
  {
    id: 'support',
    label: 'Customer support agent',
    text: `You are an expert customer support agent for a SaaS company called AcmeCloud. I would like you to carefully analyze the customer message below and then you should write a helpful reply to them.

Please make sure that you are polite and professional at all times. Please also make sure that you do not sound robotic. It is important to note that you must never share any confidential internal information with the customer. Do not make up facts. Please do not invent policies that do not exist.

In order to respond to the customer, you should first understand their issue, and then you should provide a clear and actionable answer. To restate the task, your job is to analyze the customer message and write a helpful reply that addresses every problem they mentioned.

Context: The customer's name is {{customer_name}} and their account tier is {{account_tier}}. The current date is 2026-09-15. AcmeCloud offers Basic, Pro, and Enterprise tiers. Pro and Enterprise customers get priority response within 4 hours. Basic customers get responses within 24 hours.

Customer message: "Hi, I've been charged twice this month and I can't log into my dashboard. This is really frustrating and I need help ASAP!"

Please always respond in the following format:
- Greeting with the customer's name
- Acknowledgement of each issue they raised
- Concrete next steps
- Professional closing

Remember to always be polite and professional. Please make sure the reply addresses both issues. Thanks, I appreciate it!`,
  },
  {
    id: 'coding',
    label: 'Software coding prompt',
    text: `You are a senior software engineer who is an expert in TypeScript and Node.js. I would like you to write a function for me. Please write the function carefully and make sure that it is production ready.

The function should take a string as input and it should return a number as output. Please make sure that you handle edge cases properly. Please ensure that you do not use any external dependencies. You must not use any third party libraries because the code has to run in a locked-down environment. Keep the code clean and readable. To restate the requirement: no external dependencies are allowed in the implementation.

Requirements:
- The function name must be parseDuration
- It must accept formats like "2h30m", "45m", "3h"
- It must return the total number of seconds as an integer
- Always validate input and throw a TypeError for invalid input
- Never return negative values
- Handle the seconds unit "s" as well, for example "90s"

For example, parseDuration("1h30m") returns 5400.
For instance, parseDuration("90s") returns 90.

Please write the code and also please include unit tests as well. Please make sure the tests cover the edge cases. Also please add brief comments only where necessary, do not over-comment the code. Make sure the tests cover malformed input like "abc", "", and "10x5". Thank you!`,
  },
  {
    id: 'rag',
    label: 'RAG answer with citations',
    text: `You are a document question answering assistant with access to retrieved context passages. Your task is to answer the user's question using ONLY the context provided below.

Please make sure that you do not use any outside knowledge. If the answer cannot be found in the context, it is important to state that you cannot answer based on the provided documents. You must always cite the source passage ID like [P3] for every factual claim. Do not make up citations. Never fabricate information that is not present in the context passages. To summarize your instructions: answer only from context, cite every claim, and never fabricate. It is also worth noting that you should keep your answer concise and direct without unnecessary explanation.

Context passages:
<P1>Acme Corp reported Q3 revenue of $4.2M, up 18% year over year. The growth was driven primarily by the enterprise segment, which grew 27% while self-serve declined slightly.</P1>
<P2>NetSuite migration completed in August 2026 and reduced infrastructure costs by $310K annually according to the CFO memo. The one-time migration cost was $85K.</P2>
<P3>Customer churn fell to 2.1% in Q3, the lowest level in company history, attributed to the onboarding revamp launched in May 2026.</P3>

Question: {{user_question}}

Please always respond in JSON following this exact format:
{"answer": "string", "citations": ["P1"], "confidence": 0.0}
Please respond only with valid JSON. Do not add any explanation outside the JSON. Please make sure the JSON is strictly valid. The citations array must only contain passage IDs you actually used.`,
  },
  {
    id: 'marketing',
    label: 'Marketing email copy',
    text: `You are an expert marketing copywriter who specializes in email campaigns for B2B SaaS products. As an expert, you understand what makes executives open emails.

I would like you to please write a marketing email for our upcoming product launch. Please carefully craft the email so that it is engaging and persuasive and professional. Make sure that the email is not too long. It should be short enough to keep the reader's attention from the first line. In order to maximize open rates, the subject line should be compelling. Please ensure that you include a clear call to action in the email.

Also it is important to note that the brand voice is confident but friendly. The brand never uses hype words like "revolutionary" or "game-changing". To restate the brand rules: confident but friendly, no hype words, no exclamation-mark spam.

Product details: We are launching the PromptPolice API on October 1st. PromptPolice is a tool that reduces LLM token costs by prompt compression. The target audience is engineering leaders at AI-first companies. Early signups get 30% off the first 3 months. The email recipient's first name is {{first_name}} and their company is {{company}}.

Please generate exactly 3 subject line options, one preview text, and one body of at most 120 words. Please always respond in the following format:
Subject options: ...
Preview text: ...
Body: ...

Make sure the body is at most 120 words and include the 30% discount. Thanks a lot, I really appreciate your help with this!`,
  },
  {
    id: 'extraction',
    label: 'Data extraction prompt',
    text: `You are a precise data extraction engine. Your job is to extract structured information from unstructured invoice text documents. Please carefully go through the invoice text below and extract all relevant fields into the required JSON.

It is very important that you must not hallucinate values that are not present in the document. If a field is not found, please output null for that field instead of guessing. Never invent amounts. Please do not hallucinate any numbers. To restate: only extract what is literally present in the invoice text.

Please always respond in exactly this JSON format, do not include any text outside the JSON object:
{"vendor_name": null, "invoice_number": null, "invoice_date": null, "currency": null, "subtotal": null, "tax": null, "total": null, "line_items": [{"description": null, "quantity": null, "unit_price": null}]}

All monetary values must be numbers without currency symbols. Dates must be in YYYY-MM-DD format. Never output dates in other formats. The invoice date 09/12/2026 should become "2026-09-12" for example.

Invoice text:
---
ACME SUPPLY CO.
Invoice #INV-2026-04482
Dated 09/12/2026
Payment terms: Net 30
Line items:
2x Server rack enclosure SR-900 at $475.00 each
1x Cable management kit at $300.00
Subtotal: $1,250.00
Tax (8.25%): $103.13
Total Due: $1,353.13
---

Please do the extraction now. Make sure to double check all the numbers against the invoice. Thank you!`,
  },
  {
    id: 'json-complex',
    label: 'Complex JSON-output prompt',
    text: `You are an API gateway policy generator. As an expert in cloud security, you must translate natural language requirements into a machine-readable policy document.

Your task: given the requirement text below, generate a policy JSON object. Please ensure that you follow the schema exactly. Never add extra fields that are not in the schema. Always validate that every rule has both an id and an effect. Rule ids must match the pattern in the schema.

The schema your output must conform to:
{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","required":["policy_id","version","rules"],"properties":{"policy_id":{"type":"string"},"version":{"const":"2.1"},"rules":{"type":"array","items":{"type":"object","required":["id","effect","condition"],"properties":{"id":{"type":"string","pattern":"^rule-[0-9]{4}$"},"effect":{"enum":["allow","deny"]},"condition":{"type":"object","required":["field","operator","value"],"properties":{"field":{"enum":["path","method","client_ip","user_role"]},"operator":{"enum":["equals","contains","regex","cidr_in"]},"value":{"type":["string","array"]}}}}}}}}

Requirement text:
Deny all requests to /admin/* unless the caller has the 'platform_admin' role. Allow GET requests to /health from any client. Deny any request whose client_ip is not inside {{allowed_cidr}} for the /billing endpoints.

Remember the key rules: follow the schema exactly, no extra fields, every rule needs id and effect. Please respond with valid JSON only and do not wrap it in markdown. Please make sure the output is strictly valid against the provided schema. I would like you to just output the JSON and nothing else.`,
  },
];

export function getSample(id: string): SamplePrompt | undefined {
  return SAMPLE_PROMPTS.find((s) => s.id === id);
}
