/**
 * CLI command registry for the agent-cli HTTP endpoint.
 *
 * The daemon exposes a minimal, extensible command interface over HTTP.
 * Commands are registered with a name, description, usage string, and an
 * execute function that returns the output as a string. The `help` command
 * is built-in and introspects the registry.
 */

export interface CliCommand {
  name: string;
  description: string;
  usage: string;
  execute(args: readonly string[]): string | Promise<string>;
}

const registry = new Map<string, CliCommand>();

export function registerCommand(cmd: CliCommand): void {
  registry.set(cmd.name, cmd);
}

export function getCommand(name: string): CliCommand | undefined {
  return registry.get(name);
}

export function listCommands(): readonly CliCommand[] {
  return Array.from(registry.values());
}

/** Built-in `help` command. */
const helpCommand: CliCommand = {
  name: "help",
  description: "Display available commands or help for a specific command",
  usage: "help [command]",
  execute(args: readonly string[]): string {
    if (args.length === 0) {
      const cmds = listCommands();
      if (cmds.length === 0) {
        return "No commands available.\n";
      }
      const lines = cmds.map((c) => `${c.name.padEnd(20)} ${c.description}`);
      return ["Available commands:", ...lines].join("\n") + "\n";
    }
    const name = args[0]!;
    const cmd = getCommand(name);
    if (!cmd) {
      return `Unknown command: ${name}\n`;
    }
    return `${cmd.description}\n\nUsage: ${cmd.usage}\n`;
  },
};

// Register built-in commands.
registerCommand(helpCommand);
