// The customer questions on the Pricing page: add, edit, reorder, delete,
// mark required, choose yes/no or multiple choice, and save as a whole.

import { choose, expect, expectAccessible, signIn, test } from "./support";

const question = (page: import("@playwright/test").Page, n: number) => page.getByRole("textbox", { name: `Question ${n}`, exact: true });

test("starts with the five example questions, which can be edited, reordered, deleted and saved", async ({ page }) => {
  await signIn(page, "/pricing");
  const section = page.getByRole("region", { name: "Customer questions" });
  await expect(section).toBeVisible();
  await expect(question(page, 1)).toHaveValue("Do you have any gates narrower than 60 inches?");
  await expect(question(page, 5)).toHaveValue("Is your backyard accessible to standard lawn mowing equipment?");
  await expectAccessible(page);

  // Edit, reorder with buttons (focus stays on the moved question's button), delete.
  await question(page, 3).fill("Do you have an in-ground pool?");
  await page.getByRole("button", { name: "Move question 3 up" }).click();
  await expect(question(page, 2)).toHaveValue("Do you have an in-ground pool?");
  await expect(page.getByRole("status").filter({ hasText: "Question moved to position 2 of 5." })).toHaveCount(1);
  await page.getByRole("button", { name: "Move question 1 up" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Question 1 is already first." })).toHaveCount(1);
  await page.getByRole("button", { name: "Delete question 5" }).click();
  await expect(page.getByRole("button", { name: "Add question" })).toBeFocused();

  // A new multiple-choice question, optional.
  await page.getByRole("button", { name: "Add question" }).click();
  await expect(question(page, 5)).toBeFocused();
  await question(page, 5).fill("How tall is the grass right now?");
  await choose(page, /Question 5 answer type/, "Multiple choice");
  const answers = section.getByRole("textbox", { name: "Question 5 answers, one per line" });
  await answers.fill("Under 4 inches");
  await section.locator("label.checkbox").filter({ hasText: "Question 5 required" }).click();
  await expect(page.getByText("You have unsaved changes to your questions.")).toBeVisible();

  // One answer is not a choice: refused, at the field.
  await page.getByRole("button", { name: "Save questions" }).click();
  const summary = page.getByRole("alert").filter({ hasText: "1 question needs fixing" });
  await expect(summary).toBeFocused();
  await expect(answers).toHaveAccessibleDescription(/Give at least 2 answers, one per line/);
  await expectAccessible(page);

  await answers.fill("Under 4 inches\n4 to 8 inches\nOver 8 inches");
  const saved = page.waitForRequest((r) => r.method() === "PUT" && r.url().endsWith("/questionnaire"));
  await page.getByRole("button", { name: "Save questions" }).click();
  const body = (await saved).postDataJSON() as { questions: { text: string; kind: string; options: string[]; required: boolean }[] };
  expect(body.questions.map((q) => q.text)).toEqual([
    "Do you have any gates narrower than 60 inches?",
    "Do you have an in-ground pool?",
    "Does your property have any steep hills?",
    "Are there any obstacles that could make mowing difficult?",
    "How tall is the grass right now?",
  ]);
  expect(body.questions[4]).toMatchObject({ kind: "choice", options: ["Under 4 inches", "4 to 8 inches", "Over 8 inches"], required: false });
  await expect(page.getByRole("status").filter({ hasText: "Questions saved. Homeowners now see 5 questions." })).toBeVisible();

  // Kept after a reload.
  await page.reload();
  await expect(question(page, 2)).toHaveValue("Do you have an in-ground pool?");
  await expect(question(page, 5)).toHaveValue("How tall is the grass right now?");
});

test("a question needs its text", async ({ page }) => {
  await signIn(page, "/pricing");
  await question(page, 1).fill("");
  await page.getByRole("button", { name: "Save questions" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Question 1: Enter the question" })).toBeVisible();
  await page.getByRole("link", { name: "Question 1: Enter the question" }).click();
  await expect(question(page, 1)).toBeFocused();
});
