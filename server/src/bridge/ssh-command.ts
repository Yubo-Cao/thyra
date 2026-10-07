import { isSshDestination } from "../../../shared/sshDestination";

export const SSH_NONINTERACTIVE_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "RequestTTY=no",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ControlPersist=no",
  "-o",
  "ConnectTimeout=8",
  "-o",
  "ConnectionAttempts=1",
] as const;

export function validateSshDestination(value: unknown): string {
  if (!isSshDestination(value))
    throw new Error("ssh_destination must be an OpenSSH alias or user@host");
  return value;
}

export function sshCommandArgv(
  destination: string,
  command: string,
  trustedArgs: readonly string[] = [],
): string[] {
  return [
    "ssh",
    ...SSH_NONINTERACTIVE_ARGS,
    ...trustedArgs,
    "--",
    validateSshDestination(destination),
    command,
  ];
}

export function sshTunnelArgv(
  destination: string,
  forwards: ReadonlyArray<{ local: string; remote: string }>,
): string[] {
  const argv = [
    "ssh",
    ...SSH_NONINTERACTIVE_ARGS,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=20",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "StreamLocalBindUnlink=yes",
    "-o",
    "StreamLocalBindMask=0177",
    "-N",
  ];
  for (const forward of forwards) {
    argv.push("-L", `${forward.local}:${forward.remote}`);
  }
  argv.push("--", validateSshDestination(destination));
  return argv;
}
