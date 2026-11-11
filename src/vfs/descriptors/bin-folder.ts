import { DIR_MODE, DescriptorFlags } from "../constants.ts";
import { DescriptorFolder } from "../node.ts";

/**
 * The bin folder descriptor.
 *
 * A simple folder that contains the CLI shim. It is read-only and does not
 * support any write operations.
 */
export class BinFolderDescriptor extends DescriptorFolder {
  constructor() {
    super({
      mode: DIR_MODE,
      flags: DescriptorFlags.CanRead,
    });
  }
}
