import { QuestionCard } from "@moonlet/ds";

export const SingleChoice = () => (
  <div className="bg-bg p-3" style={{ width: 560 }}>
    <QuestionCard
      onAnswer={() => {}}
      ask={{
        id: "q1",
        tool: "AskUserQuestion",
        summary: "",
        can_always: false,
        input: {
          questions: [
            {
              question: "Which storage should the refund log use?",
              header: "Storage",
              options: [
                { label: "Postgres", description: "Same database as payments; transactional with the refund." },
                { label: "Redis stream", description: "Faster, but entries expire after 7 days." },
              ],
            },
          ],
        },
      }}
    />
  </div>
);

export const MultiSelect = () => (
  <div className="bg-bg p-3" style={{ width: 560 }}>
    <QuestionCard
      onAnswer={() => {}}
      ask={{
        id: "q2",
        tool: "AskUserQuestion",
        summary: "",
        can_always: false,
        input: {
          questions: [
            {
              question: "Which checks should run before the PR?",
              header: "Checks",
              multiSelect: true,
              options: [{ label: "Unit tests" }, { label: "Visual regression" }, { label: "Lint" }],
            },
          ],
        },
      }}
    />
  </div>
);
