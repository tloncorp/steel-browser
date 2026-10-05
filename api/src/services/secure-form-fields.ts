/** HTML autofill purposes, with presentation hints for the trusted entry screen. */
export const secureFieldDefinitions = [
  {
    purpose: "username",
    label: "Email, phone, or username",
    inputType: "text",
    pattern: "user\\s*name|login|account|email|e-mail|phone|mobile",
  },
  { purpose: "current-password", label: "Password", inputType: "password" },
  { purpose: "new-password", label: "New password", inputType: "password" },
  {
    purpose: "one-time-code",
    label: "Verification code",
    inputType: "text",
    pattern:
      "one[\\s_-]*time|verification|security[\\s_-]*code|auth(?:entication)?[\\s_-]*code|\\botp\\b|\\b2fa\\b|two[\\s_-]*factor|passcode|login[\\s_-]*code",
  },
  {
    purpose: "cc-number",
    label: "Card number",
    inputType: "numeric",
    pattern: "(?:card|cc|credit)\\s*(?:number|num|no)",
  },
  {
    purpose: "cc-csc",
    label: "Card security code",
    inputType: "password",
    pattern: "\\b(?:cvv|cvc|csc)\\b|card\\s*(?:security|verification)\\s*code",
  },
  {
    purpose: "cc-exp-month",
    label: "Expiration month",
    inputType: "numeric",
    pattern: "exp(?:iry|iration)?\\s*month",
  },
  {
    purpose: "cc-exp-year",
    label: "Expiration year",
    inputType: "numeric",
    pattern: "exp(?:iry|iration)?\\s*year",
  },
  {
    purpose: "cc-exp",
    label: "Expiration date",
    inputType: "text",
    pattern: "exp(?:iry|iration)?\\s*(?:date)?",
  },
  {
    purpose: "cc-name",
    label: "Name on card",
    inputType: "text",
    pattern: "card\\s*holder|name on (?:the )?card",
  },
  { purpose: "cc-given-name", label: "First name on card", inputType: "text" },
  { purpose: "cc-additional-name", label: "Middle name on card", inputType: "text" },
  { purpose: "cc-family-name", label: "Last name on card", inputType: "text" },
  { purpose: "cc-type", label: "Card type", inputType: "text" },
  {
    purpose: "given-name",
    label: "First name",
    inputType: "text",
    pattern: "first\\s*name|given\\s*name",
  },
  {
    purpose: "additional-name",
    label: "Middle name",
    inputType: "text",
    pattern: "middle\\s*name",
  },
  {
    purpose: "family-name",
    label: "Last name",
    inputType: "text",
    pattern: "last\\s*name|family\\s*name|surname",
  },
  { purpose: "name", label: "Full name", inputType: "text", pattern: "full\\s*name|\\bname\\b" },
  { purpose: "organization", label: "Company", inputType: "text", pattern: "company|organization" },
  {
    purpose: "address-line1",
    label: "Address line 1",
    inputType: "text",
    pattern: "address\\s*(?:line\\s*)?1|street(?: address)?",
  },
  {
    purpose: "address-line2",
    label: "Address line 2",
    inputType: "text",
    pattern: "address\\s*(?:line\\s*)?2|apartment|suite",
  },
  {
    purpose: "address-line3",
    label: "Address line 3",
    inputType: "text",
    pattern: "address\\s*(?:line\\s*)?3",
  },
  { purpose: "street-address", label: "Street address", inputType: "textarea" },
  {
    purpose: "address-level1",
    label: "State or province",
    inputType: "text",
    pattern: "\\bstate\\b|province|region",
  },
  {
    purpose: "address-level2",
    label: "City",
    inputType: "text",
    pattern: "\\bcity\\b|\\btown\\b|locality",
  },
  { purpose: "address-level3", label: "District", inputType: "text" },
  { purpose: "address-level4", label: "Neighborhood", inputType: "text" },
  {
    purpose: "postal-code",
    label: "Postal code",
    inputType: "text",
    pattern: "postal|postcode|zip\\s*(?:code)?",
  },
  { purpose: "country", label: "Country", inputType: "text", pattern: "country" },
  { purpose: "country-name", label: "Country", inputType: "text" },
  { purpose: "email", label: "Email", inputType: "email", pattern: "email|e-mail" },
  {
    purpose: "tel",
    label: "Phone number",
    inputType: "tel",
    pattern: "phone|mobile|telephone|^tel$",
  },
] as const;

export type SecureFieldPurpose = (typeof secureFieldDefinitions)[number]["purpose"];
export interface SecureFormField {
  id: string;
  purpose: SecureFieldPurpose;
  label: string;
  inputType: "text" | "password" | "numeric" | "email" | "tel" | "textarea" | "select";
  required: boolean;
  maxLength?: number;
  exactLength?: number;
  options?: Array<{ value: string; label: string }>;
}
