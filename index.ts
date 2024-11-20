import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { erc7579Actions } from "permissionless/actions/erc7579";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbiParameters,
  toFunctionSelector,
  toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { baseSepolia } from "viem/chains";
import axios from "axios";
import { buildPoseidon } from "circomlibjs";

import config from "./config.ts";
import { universalEmailRecoveryModuleAbi } from "./abi/UniversalEmailRecoveryModule.ts";
import { safeAbi } from "./abi/Safe.ts";
import {
  GetAccountSaltResponseSchema,
  HandleAcceptanceResponseSchema,
  HandleRecoveryResponseSchema,
  CompleteRecoveryResponseSchema,
} from "./types.ts";

// Install module and configure recovery
const publicClient = createPublicClient({
  transport: http(config.rpcUrl),
});

const pimlicoClient = createPimlicoClient({
  transport: http(config.bundlerUrl),
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7",
  },
});

const owner = privateKeyToAccount(config.ownerPrivateKey);
const safeAccount = await toSafeSmartAccount({
  client: publicClient,
  owners: [owner],
  version: "1.4.1",
  entryPoint: {
    address: entryPoint07Address,
    version: "0.7",
  },
  safe4337ModuleAddress: config.addresses.safe4337ModuleAddress,
  erc7579LaunchpadAddress: config.addresses.erc7569LaunchpadAddress,
  attesters: [config.addresses.attestor], // This address belongs to Rhinestone. By designating them as attesters, you authorize that only modules explicitly approved by Rhinestone can be installed on your safe.
  attestersThreshold: 1,
});
const safeWalletAddress = safeAccount.address;

const smartAccountClient = createSmartAccountClient({
  account: safeAccount,
  chain: baseSepolia,
  bundlerTransport: http(config.bundlerUrl),
  paymaster: pimlicoClient,
  userOperation: {
    estimateFeesPerGas: async () => {
      return (await pimlicoClient.getUserOperationGasPrice()).fast;
    },
  },
}).extend(erc7579Actions());

const universalEmailRecoveryModuleAddress = config.addresses.universalEmailRecoveryModule;
const guardianEmail = "guardian@gmail.com";

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .reverse()
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

const poseidon = await buildPoseidon();
const accountCodeBytes: Uint8Array = poseidon.F.random();
const accountCode = bytesToHex(accountCodeBytes);

const getAccountSaltResponse = await axios({
  method: "POST",
  url: `${config.relayerApiUrl}/getAccountSalt`,
  data: {
    account_code: accountCode,
    email_addr: guardianEmail,
  },
});
const guardianSalt = GetAccountSaltResponseSchema.parse(
  getAccountSaltResponse.data
);

// The guardian address is generated by sending the user's account address and guardian salt to the computeEmailAuthAddress function
const guardianAddr = await publicClient.readContract({
  abi: universalEmailRecoveryModuleAbi,
  address: config.addresses.universalEmailRecoveryModule,
  functionName: "computeEmailAuthAddress",
  args: [safeWalletAddress, guardianSalt],
});

const account = safeWalletAddress;
const isInstalledContext = toHex(0);
const functionSelector = toFunctionSelector(
  "swapOwner(address,address,address)"
);
const guardians = [guardianAddr];
const guardianWeights = [1n];
const threshold = 1n;
const delay = 0n; // seconds
const expiry = 2n * 7n * 24n * 60n * 60n; // 2 weeks in seconds

const moduleData = encodeAbiParameters(
  parseAbiParameters(
    "address, bytes, bytes4, address[], uint256[], uint256, uint256, uint256"
  ),
  [
    account,
    isInstalledContext,
    functionSelector,
    guardians,
    guardianWeights,
    threshold,
    delay,
    expiry,
  ]
);
const userOpHash = await smartAccountClient.installModule({
  type: "executor",
  address: universalEmailRecoveryModuleAddress,
  context: moduleData,
});

const receipt = await pimlicoClient.waitForUserOperationReceipt({
  hash: userOpHash,
});

// Handle Acceptance
const subject = await publicClient.readContract({
  abi: universalEmailRecoveryModuleAbi,
  address: config.addresses.universalEmailRecoveryModule,
  functionName: "acceptanceCommandTemplates",
  args: [],
});

const templateIdx = 1;
const handleAcceptanceCommand = subject[0]
  ?.join()
  .replaceAll(",", " ")
  .replace("{ethAddr}", safeWalletAddress);

const handleAcceptanceResponse = await axios({
  method: "POST",
  url: `${config.relayerApiUrl}/acceptanceRequest`,
  data: {
    controller_eth_addr: universalEmailRecoveryModuleAddress,
    guardian_email_addr: guardianEmail,
    account_code: accountCode,
    template_idx: templateIdx,
    command: handleAcceptanceCommand,
  },
});
const { requestId: handleAcceptanceRequestId } =
  HandleAcceptanceResponseSchema.parse(handleAcceptanceResponse.data);

// Handle Recovery
const processRecoveryCommand = await publicClient.readContract({
  abi: universalEmailRecoveryModuleAbi,
  address: config.addresses.universalEmailRecoveryModule,
  functionName: "recoveryCommandTemplates",
  args: [],
}); //  as [][];

const handleRecoveryResponse = await axios({
  method: "POST",
  url: `${config.relayerApiUrl}/recoveryRequest`,
  data: {
    controller_eth_addr: universalEmailRecoveryModuleAddress,
    guardian_email_addr: guardianEmail,
    template_idx: templateIdx,
    command: processRecoveryCommand,
  },
});
const { requestId: handleRecoveryRequestId } =
  HandleRecoveryResponseSchema.parse(handleRecoveryResponse.data);

// Complete Recovery

const previousOwnerInLinkedList = "0x0000000000000000000000000000000000000000";
const oldOwner = "0x0000000000000000000000000000000000000000";
const newOwner = "0x0000000000000000000000000000000000000000";

const recoveryCallData = encodeFunctionData({
  abi: safeAbi,
  functionName: "swapOwner",
  args: [previousOwnerInLinkedList, oldOwner, newOwner],
});

const recoveryData = encodeAbiParameters(parseAbiParameters("address, bytes"), [
  safeWalletAddress,
  recoveryCallData,
]);

const completeRecoveryResponse = await axios({
  method: "POST",
  url: `${config.relayerApiUrl}/completeRequest`,
  data: {
    controller_eth_addr: universalEmailRecoveryModuleAddress,
    account_eth_addr: safeWalletAddress,
    complete_calldata: recoveryData,
  },
});
CompleteRecoveryResponseSchema.parse(completeRecoveryResponse.data);
