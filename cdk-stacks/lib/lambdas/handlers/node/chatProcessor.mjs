// index.mjs (or set "type": "module" in package.json)
import { fromWebToken } from "@aws-sdk/credential-providers";
import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';

const DynamoDBService = require('./services/DynamoDBService.mjs');
const PinpointService = require('./services/PinpointService.mjs');
const QBusinessService = require('./services/QBusinessService.mjs');
const restartKeywords = ['restart','begin','commence','initiate','launch','commence','start','demo','go','reset', 'clear'];


// Function to fetch ID token
const fetchIdToken = async (issuer, email) => {
    if (!issuer) {
        throw new Error("Issuer URL is required");
    }

    const dummyAuth = Buffer.from('dummy-client:dummy-secret').toString('base64');
    const response = await fetch(`${issuer}/token`, {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${dummyAuth}`,
            'Content-Type': 'application/json',
            'origin': 'https://www.my-cool-website.com'
        },
        body: JSON.stringify({ email }),
    });

    if (!response.ok) {
        throw new Error('Failed to fetch ID token');
    }

    const data = await response.json();
    return data.id_token;
};

// Function to create AWS credentials using ID token
const createCredentials = async (issuer, email, region, roleArn) => {
    const idToken = await fetchIdToken(issuer, email);
    const provider = fromWebToken({
        roleArn,
        webIdentityToken: idToken,
        clientConfig: { region },
        roleSessionName: `session-${uuidv4()}-${Date.now()}`,
        durationSeconds: 900, // 15 minutes
    });

    const credentials = await provider();
    return credentials;
};

export const handler = async (event) => {
    console.debug('event - '+JSON.stringify(event, null, 2));

    const issuer = process.env.ISSUER_URL; 
    const region = process.env.AWS_REGION;
    const roleArn = process.env.ASSUME_ROLE_ARN; 

    try {

        for (const record of event.Records) {
            var snsMessage = JSON.parse(record.Sns.Message);

            if(restartKeywords.includes(snsMessage.messageBody.toLowerCase().trim())){
                // Creating a new session
                await DynamoDBService.deleteItemsByPartitionKey(process.env.CONTEXT_DYNAMODB_TABLE, 'phoneNumber', snsMessage.originationNumber);
                await PinpointService.sendSMS(snsMessage.originationNumber, "Please ask a question.");

            } else {

                // Retrieve past conversation Id to be able to continue the conversation if it exists
                const queryParams = {
                    TableName: process.env.CONTEXT_DYNAMODB_TABLE,
                    KeyConditionExpression: "phoneNumber = :phoneValue",
                    ExpressionAttributeValues: {
                        ":phoneValue": snsMessage.originationNumber
                    }
                };

                const stored_data = await DynamoDBService.query(queryParams);
                if(stored_data[0] && stored_data[0].phoneNumber == snsMessage.originationNumber){
                    // Delete the old conversation data as we will insert new data later
                    await DynamoDBService.deleteItemsByPartitionKey(process.env.CONTEXT_DYNAMODB_TABLE, 'phoneNumber', snsMessage.originationNumber);
                }

                // Processing credentials
                let credentials = await createCredentials(issuer, snsMessage.originationNumber, region, roleArn);

                // Sending user prompt to Q Business with and without previous conversation
                let answer;
                if(stored_data[0] && stored_data[0].conversationId){
                    answer = await QBusinessService.sendChat(credentials, snsMessage.messageBody, stored_data[0].conversationId, stored_data[0].messageId);
                }else{
                    answer = await QBusinessService.sendChat(credentials, snsMessage.messageBody);
                }

                console.debug(JSON.stringify(answer));
                console.log(answer.systemMessage);

                // Write processed conversation into DynamoDB for next iteration use
                const putParams = {
                    phoneNumber: snsMessage.originationNumber,
                    conversationId: answer.conversationId,
                    messageId: answer.systemMessageId,
                    timestamp: Date.now()
                }
                await DynamoDBService.put(process.env.CONTEXT_DYNAMODB_TABLE, putParams);

                // Finally sending the response back from Q Business to SMS
                await PinpointService.sendSMS(snsMessage.originationNumber, answer.systemMessage);

            }
        }

        return {
            statusCode: 200,
            body: 'successful',
        };
    } catch (error) {
        console.error("General Error:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message }),
        };
    }
};
