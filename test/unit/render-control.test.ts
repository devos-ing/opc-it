import { expect, test } from "bun:test";
import { renderControlWorkflow } from "../../scripts/render-control.js";

test("renders every Action from the full control repository", () => {
  const rendered = renderControlWorkflow(
    'uses: "{{control_repository}}@{{control_action_sha}}"\n',
    "devos-ing/opc-it",
    "a".repeat(40),
  );
  expect(rendered).toBe(`uses: "devos-ing/opc-it@${"a".repeat(40)}"\n`);
});

test("rejects unresolved control workflow tokens", () => {
  expect(() =>
    renderControlWorkflow(
      "name: '{{unknown_token}}'\n",
      "devos-ing/opc-it",
      "a".repeat(40),
    ),
  ).toThrow("UNRESOLVED_CONTROL_TOKEN");
});
