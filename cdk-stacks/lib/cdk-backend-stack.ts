// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0

import {CfnOutput, Stack, StackProps, Duration, CustomResource, RemovalPolicy} from "aws-cdk-lib";
import {Construct} from "constructs";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import {Runtime} from "aws-cdk-lib/aws-lambda";
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as kms from "aws-cdk-lib/aws-kms";
import * as logs from "aws-cdk-lib/aws-logs";
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { loadSSMParams } from '../lib/infrastructure/ssm-params-util';
import { NagSuppressions } from 'cdk-nag'
import path = require('path');

const configParams = require('../config.params.json');

export class CdkBackendStack extends Stack {

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const ssmParams = loadSSMParams(this);

    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason: 'This is the default Lambda Execution Policy which just grants writes to CloudWatch.'
      },
    ])

    //SNS Topic for 2-way SMS
    const aws_sns_kms = kms.Alias.fromAliasName(
      this,
      "aws-managed-sns-kms-key",
      "alias/aws/sns",
    )
    const chatTopic = new sns.Topic(this,'notification', {
      displayName: `${configParams.CdkAppName}-NotificationTopic`,
      masterKey: aws_sns_kms
    })

    const snsRole = new iam.Role(this, 'snsRole', {
      assumedBy: new iam.ServicePrincipal('sms-voice.amazonaws.com')
    });

    snsRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "sns:Publish",
        ],
        resources: [
          chatTopic.topicArn
        ]
      })
    )

    //Custom Resource Lambda
    const configLambda = new nodeLambda.NodejsFunction(this, 'ConfigLambda', {
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(__dirname, 'lambdas/handlers/node/customResource.mjs'),
      timeout: Duration.seconds(30),
      memorySize: 512,
      initialPolicy: 
      [
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "sms-voice:UpdatePhoneNumber",
          ],
          resources: [
              `arn:aws:sms-voice:${this.region}:${this.account}:phone-number/${ssmParams.originationNumberId}`
          ]
        }),new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "iam:PassRole"
          ],
          resources: [
              `${snsRole.roleArn}`
          ]
        })
      ]
    });

    //Chat Context Table
    const contextTable = new dynamodb.Table(this, 'ChatContext', { 
      partitionKey: { name: 'phoneNumber', type: dynamodb.AttributeType.STRING }, 
      sortKey: { name: 'messageId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: true,
      removalPolicy: RemovalPolicy.DESTROY 
    });

    contextTable.addGlobalSecondaryIndex({
      indexName: 'PhoneIndex',
      partitionKey: {
        name: 'phoneNumber',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'timestamp',
        type: dynamodb.AttributeType.NUMBER,
      },
      projectionType: dynamodb.ProjectionType.ALL
    });

    //Custom Log Group so we can add Metric Filters
    const logGroup = new logs.LogGroup(this, 'EnterpriseMobileChatAssistantChatProcessor',{
      retention: logs.RetentionDays.THREE_MONTHS
    });

    const chatProcessorLambda = new nodeLambda.NodejsFunction(this, 'chatProcessorLambda', {
      runtime: Runtime.NODEJS_22_X,
      entry: path.join(__dirname, 'lambdas/handlers/node/chatProcessor.mjs'),
      timeout: Duration.seconds(30),
      memorySize: 512,
      logFormat: 'JSON',
      applicationLogLevel: 'INFO',
      logGroup: logGroup,
      bundling: {
        externalModules: [], 
      },
      environment: { 
          "PHONE_NUMBER_ID": ssmParams.originationNumberId,
          "ISSUER_URL": ssmParams.viteIssuerUrl,
          "ASSUME_ROLE_ARN": ssmParams.viteIAMAssumeRoleARN,
          "QBUSINESS_APPLICATION_ID": ssmParams.qBusinessApplicationId,
          "CONTEXT_DYNAMODB_TABLE": contextTable.tableName
        }
    });
    //Policy for Lambda
    chatProcessorLambda.role?.attachInlinePolicy(new iam.Policy(this, 'chatProcessorPolicy', {
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [                
                "dynamodb:GetItem",
                "dynamodb:Query",
                "dynamodb:Scan",
                "dynamodb:PutItem",
                "dynamodb:BatchWriteItem",
                "dynamodb:DeleteItem"
            ],
            resources: [
              contextTable.tableArn, 
              `${contextTable.tableArn}/*`
            ]
          }), 
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [                
              "sms-voice:SendTextMessage",
              "sms-voice:SendMediaMessage"
            ],
            resources: [
              `arn:aws:sms-voice:${this.region}:${this.account}:phone-number/${ssmParams.originationNumberId}`
            ]
          })
      ]
    }));

    NagSuppressions.addResourceSuppressionsByPath(this, '/EnterpriseMobileChatAssistant/chatProcessorPolicy/Resource', [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The function needs to call DynamoDB items, which requires a wildcard resource under DynamoDB table resource.'
      },
    ])
    
    if (ssmParams.originationNumberId) {
      // subscribe an Lambda to SMS SNS topic
      chatTopic.addSubscription(new subscriptions.LambdaSubscription(chatProcessorLambda));

      snsRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: [
            "sns:Publish",
            "sns:Subscribe",
          ],
          resources: [
            chatTopic.topicArn
          ]
        })
      )
    } 


    const configCustomResource = new CustomResource(this, `${configParams.CdkAppName}-ConfigCustomResource`, {
        resourceType: 'Custom::EUMConfig',
        serviceToken: configLambda.functionArn,
        properties: {
            OriginationNumberId: ssmParams.originationNumberId,
            ChatSNSTopicARN: chatTopic.topicArn,
            SNSRoleARN: snsRole.roleArn,
        }
    });
  
    /**************************************************************************************************************
      * CDK Outputs *
    **************************************************************************************************************/

    new CfnOutput(this, "chatProcessorLambdaName", {
      value: chatProcessorLambda.functionName
    });

    new CfnOutput(this, "chatProcessorLambdaARN", {
      value: chatProcessorLambda.functionArn
    });
  }
}
