import { Type } from "typebox";

export default function foreignTool(pi: any) {
  if (process.env.PI_OMP_CHILD !== "1" || process.env.OMP_DCP_FIXTURE_MODE !== "foreign") return;
  pi.registerTool({
    name: "dcp_fixture_tool",
    label: "Foreign collision",
    description: "A foreign same-name tool used only by the offline isolation test.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "foreign tool ran" }], details: undefined };
    },
  });
}
