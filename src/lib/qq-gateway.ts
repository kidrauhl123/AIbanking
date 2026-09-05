import {
  handleChannelAction,
  handleChannelMessage,
  type ChannelActionInput,
  type ChannelMessageInput,
} from "./im-gateway";

const config = { channelType: "QQ", bindingPath: "/connect/qq" } as const;

export type QqMessageInput = ChannelMessageInput;
export type QqActionInput = ChannelActionInput;

export const handleQqMessage = (input: QqMessageInput) => handleChannelMessage(config, input);
export const handleQqAction = (input: QqActionInput) => handleChannelAction(config, input);
