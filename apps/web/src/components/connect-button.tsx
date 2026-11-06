"use client";

import { Wallet } from "@varada/ui/components/ui/icons";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { Button } from "@varada/ui/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@varada/ui/components/ui/dropdown-menu";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function ConnectButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();

  if (isConnected && address) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="font-mono" aria-label={`Wallet ${address}`}>
            <Wallet aria-hidden="true" />
            {short(address)}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="font-mono text-xs break-all">{address}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => disconnect()}>Disconnect</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  const connector = connectors[0];
  return (
    <Button disabled={!connector} onClick={() => connector && connect({ connector })}>
      <Wallet aria-hidden="true" />
      Connect wallet
    </Button>
  );
}
