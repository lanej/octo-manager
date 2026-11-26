import { fromBinary } from "@bufbuild/protobuf";
import {
  type DescriptorProto,
  type FieldDescriptorProto,
  FieldDescriptorProto_Type,
  FileDescriptorSetSchema,
  type SourceCodeInfo,
} from "@bufbuild/protobuf/wkt";

const path = process.argv[2];
if (path === undefined)
  throw new Error("Expected a compiled Protobuf descriptor set");
const descriptors = fromBinary(
  FileDescriptorSetSchema,
  new Uint8Array(await Bun.file(path).arrayBuffer()),
);

for (const file of descriptors.file) {
  const locations = new Map(
    file.sourceCodeInfo?.location.map((location) => [
      location.path.join("."),
      location,
    ]),
  );
  const inspect = (
    field: FieldDescriptorProto,
    scope: string,
    location: SourceCodeInfo["location"][number] | undefined,
  ) => {
    if (
      field.type !== FieldDescriptorProto_Type.STRING ||
      !field.name.endsWith("_json")
    )
      return;
    const [line = 0, column = 0] = location?.span ?? [];
    console.error(
      `${file.name}:${String(line + 1)}:${String(column + 1)}: FIELD_NO_JSON_STRING: ${scope}${field.name} must use typed message fields`,
    );
    process.exitCode = 1;
  };
  const message = (
    descriptor: DescriptorProto,
    scope: string,
    prefix: string,
  ) => {
    const qualified = `${scope}${descriptor.name}.`;
    for (const [index, field] of descriptor.field.entries())
      inspect(field, qualified, locations.get(`${prefix}.2.${String(index)}`));
    for (const [index, field] of descriptor.extension.entries())
      inspect(field, qualified, locations.get(`${prefix}.6.${String(index)}`));
    for (const [index, nested] of descriptor.nestedType.entries())
      message(nested, qualified, `${prefix}.3.${String(index)}`);
  };
  const scope = file.package === "" ? "" : `${file.package}.`;
  for (const [index, descriptor] of file.messageType.entries())
    message(descriptor, scope, `4.${String(index)}`);
  for (const [index, field] of file.extension.entries())
    inspect(field, scope, locations.get(`7.${String(index)}`));
}
