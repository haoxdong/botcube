from typing import NotRequired, TypedDict


class DeploymentFixture(TypedDict):
    rolloutState: str
    id: NotRequired[str]
    taskDefinition: NotRequired[str]
    status: NotRequired[str]


class ServiceFixture(TypedDict):
    taskDefinition: str
    desiredCount: int
    runningCount: int
    pendingCount: int
    deployments: list[DeploymentFixture]


class CircuitBreakerFixture(TypedDict):
    enable: bool
    rollback: bool


class DeploymentConfigurationFixture(TypedDict):
    minimumHealthyPercent: int
    maximumPercent: int
    deploymentCircuitBreaker: CircuitBreakerFixture


class ReplacementServiceFixture(ServiceFixture):
    deploymentConfiguration: DeploymentConfigurationFixture
