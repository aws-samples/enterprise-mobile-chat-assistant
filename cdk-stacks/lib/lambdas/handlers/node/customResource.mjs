import { sendSuccess, sendFailure, sendResponse} from 'cfn-custom-resource';
import { PinpointSMSVoiceV2Client, UpdatePhoneNumberCommand } from "@aws-sdk/client-pinpoint-sms-voice-v2"; // ES Modules import


import crypto from 'crypto';
const pinpointClient = new PinpointSMSVoiceV2Client({});

const updatePhoneNumber = async (props) => {
  try {
    const input = { 
      PhoneNumberId: props.OriginationNumberId, 
      TwoWayEnabled: true,
      TwoWayChannelArn: props.ChatSNSTopicARN,
      TwoWayChannelRole: props.SNSRoleARN,
      SelfManagedOptOutsEnabled: false,
      DeletionProtectionEnabled: false,
    };
    console.trace(input)
    const command = new UpdatePhoneNumberCommand(input);
    const response = await pinpointClient.send(command);
    console.trace(response);
    return response
  }
  catch (error) {
      console.error(error);
      return false
  }
}

/****************
 * Main
****************/
export const handler = async (event, context, callback) => {
    console.log('Received event:', JSON.stringify(event, null, 2));

    const props = event.ResourceProperties
    const requestType = event.RequestType
    let physicalId = event.PhysicalResourceId

    if (requestType === 'Create') {
        physicalId = `vce.eum-config.${crypto.randomUUID()}`
    } else if(!physicalId) {
        sendResponse(event, context.logStreamName, 'FAILED', `invalid request: request type is '${requestType}' but 'PhysicalResourceId' is not defined`)
    }

    try{
      switch (event.ResourceType){
        case 'Custom::EUMConfig':
          if (requestType === 'Create' || requestType === 'Update'){
            //Create or Update Stuff
            await updatePhoneNumber(props);
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else if(requestType === 'Delete'){
            //Delete Stuff
            const result = await sendSuccess(physicalId, { }, event);
            return result
          } else {
            const result = await sendSuccess(physicalId, { }, event);
            return result
          }

        default:
          const result = await sendSuccess(physicalId, { }, event);
          return result
      }
    }
    catch (ex){
      console.log(ex);
      const result = await sendFailure(physicalId, ex, event);
      return result
    }
};

