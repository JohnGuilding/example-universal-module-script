import axios from "axios";
import { universalEmailRecoveryModuleAbi } from "../../abi/UniversalEmailRecoveryModule.ts";
import { GetAccountSaltResponseSchema } from "../types.ts";
import config from "../../config.ts";
import { publicClient, getSafeAccount } from "../clients.ts";
import type { Hex } from "viem";

/** Computes the guardian address for a given account code and guardian email */
export const computeGuardianAddress = async (
  accountCode: Hex,
  guardianEmail: string
) => {
  const safeAccount = await getSafeAccount();

  const getAccountSaltResponse = await axios({
    method: "POST",
    url: `${config.relayerApiUrl}/getAccountSalt`,
    data: {
      account_code: accountCode.slice(2),
      email_addr: guardianEmail,
    },
  });
  const guardianSalt = GetAccountSaltResponseSchema.parse(
    getAccountSaltResponse.data
  );

  // The guardian address is generated by sending the user's account address and guardian salt to the computeEmailAuthAddress function
  return await publicClient.readContract({
    abi: universalEmailRecoveryModuleAbi,
    address: config.addresses.universalEmailRecoveryModule,
    functionName: "computeEmailAuthAddress",
    args: [safeAccount.address, guardianSalt],
  });
};
