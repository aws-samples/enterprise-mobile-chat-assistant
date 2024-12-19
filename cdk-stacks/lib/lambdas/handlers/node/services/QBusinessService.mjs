// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import { QBusiness } from "@aws-sdk/client-qbusiness";

export async function sendChat (credentials, message, conversationId = null, parentMessageId = null, retryCount = 0) {
  const MAX_RETRIES = 3;
  var amazonQ = new QBusiness({
      credentials: credentials,
      region: process.env.AWS_REGION
  });

  let chatSync_param;
  if(conversationId){
    chatSync_param = {
        applicationId: process.env.QBUSINESS_APPLICATION_ID,
        chatMode: 'RETRIEVAL_MODE',
        conversationId: conversationId,
        parentMessageId: parentMessageId,
        userMessage: message,
    };
  }else{
    chatSync_param = {
        applicationId: process.env.QBUSINESS_APPLICATION_ID,
        chatMode: 'RETRIEVAL_MODE',
        userMessage: message,
    };
  }

  try{
    return await amazonQ.chatSync(chatSync_param);
  }catch(error){
    console.log('QBusiness.chatSync Error: ', error);

    if (retryCount >= MAX_RETRIES) {
      throw new Error(`Failed after ${MAX_RETRIES} retries: ${error.message}`);
    }

    // Exponential backoff
    const delay = Math.pow(2, retryCount) * 1000;
    await new Promise(resolve => setTimeout(resolve, delay));

    return sendChat(credentials, message, conversationId, parentMessageId, retryCount + 1);
  }

}