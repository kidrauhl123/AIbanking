import {
  handleChannelAction,
  handleChannelMessage,
  type ChannelActionInput,
  type ChannelMessageInput,
} from "./im-gateway";

const config = { channelType: "WECOM", bindingPath: "/connect/wecom" } as const;

export type WecomMessageInput = ChannelMessageInput;
export type WecomActionInput = ChannelActionInput;

export const handleWecomMessage = (input: WecomMessageInput) => handleChannelMessage(config, input);
export const handleWecomAction = (input: WecomActionInput) => handleChannelAction(config, input);
