import { describeStorageProviderContract } from "../../core/tests/storage-provider-contract.js";
import { createMemoryStorageProvider } from "../src/index.js";

describeStorageProviderContract("memory", () => ({
  provider: createMemoryStorageProvider(),
}));
