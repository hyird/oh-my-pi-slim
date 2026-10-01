import { Type } from "typebox";

export default function dcpFixture(pi: any) {
  const mode = process.env.OMP_DCP_FIXTURE_MODE;
  if (process.env.PI_OMP_CHILD === "1" && mode === "loadfail") throw new Error("local fixture provider load failure");
  if (process.env.PI_OMP_CHILD === "1" && (mode === "missing" || mode === "foreign")) return;
  pi.registerTool({
    name: process.env.PI_OMP_CHILD === "1" && mode === "unregistered" ? "dcp_child_different" : "dcp_fixture_tool",
    label: "DCP fixture",
    description: "A local fixture tool used to verify OMP tool inheritance.",
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "fixture tool ran" }], details: undefined };
    },
  });
}
