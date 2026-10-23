//! Cloud workers (X63): machines a central host rents from a provider to run
//! heavy commands, and removes once they sit idle. This crate holds what does
//! not need the network or the daemon: the provider contract and its
//! adapters, machine names and labels, the cloud-init script, the idle time,
//! the sweep and the usage count. The daemon sends the requests through a
//! [`Transport`].

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

pub mod cloud_init;
pub mod hetzner;
pub mod machine;

/// What a provider's machine is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MachineState {
    Starting,
    Running,
    /// No longer at the provider.
    Gone,
}

/// A machine type a provider offers at a location.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineType {
    pub name: String,
    pub cores: u32,
    pub memory_gb: f64,
    /// `x86` or `arm`.
    pub arch: String,
}

/// What `create` makes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewMachine {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub location: String,
    pub image: String,
    pub user_data: String,
    pub labels: BTreeMap<String, String>,
}

/// What `get` says of a machine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MachineInfo {
    pub state: MachineState,
    pub ipv4: Option<String>,
}

/// A machine as `list` gives it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Listed {
    pub id: String,
    pub name: String,
    pub labels: BTreeMap<String, String>,
    /// Unix milliseconds.
    pub created_at: u64,
}

/// A settings field of a provider, for the form the app builds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub name: String,
    pub label: String,
    pub secret: bool,
    pub help: String,
}

/// A provider moonlet knows.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub label: String,
    pub fields: Vec<Field>,
    /// The longest machine name it takes.
    pub max_name: usize,
}

/// Every provider, for the app's **Add provider**.
pub fn providers() -> Vec<ProviderInfo> {
    vec![hetzner::info()]
}

/// Why a provider call failed, as the user reads it.
#[derive(Debug, Clone, PartialEq)]
pub enum CloudError {
    /// The provider refused the credentials.
    Refused(String),
    /// The provider answered with an error: its status and message.
    Provider(String),
    /// The provider could not be reached, or answered with something else.
    Network(String),
}

impl std::fmt::Display for CloudError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CloudError::Refused(m) | CloudError::Provider(m) | CloudError::Network(m) => {
                f.write_str(m)
            }
        }
    }
}

impl std::error::Error for CloudError {}

/// An HTTP request an adapter wants sent.
#[derive(Debug, Clone, PartialEq)]
pub struct Request {
    pub method: &'static str,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<serde_json::Value>,
}

/// The provider's answer.
#[derive(Debug, Clone, PartialEq)]
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    /// Header `name`, whatever its case.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Sends requests, waits and tells the time: the daemon's network, or a
/// test's script.
#[async_trait::async_trait]
pub trait Transport: Send + Sync {
    async fn send(&self, request: Request) -> Result<Response, String>;
    async fn sleep(&self, duration: Duration);
    /// Unix seconds.
    fn now(&self) -> u64;
}

/// A cloud provider: everything specific to one sits behind this.
#[async_trait::async_trait]
pub trait Provider: Send + Sync {
    fn info(&self) -> ProviderInfo;
    async fn machine_types(&self, location: &str) -> Result<Vec<MachineType>, CloudError>;
    /// Makes a machine; gives its provider id.
    async fn create(&self, machine: &NewMachine) -> Result<String, CloudError>;
    async fn get(&self, id: &str) -> Result<MachineInfo, CloudError>;
    /// The machines carrying every label of `labels`.
    async fn list(&self, labels: &BTreeMap<String, String>) -> Result<Vec<Listed>, CloudError>;
    /// Asks for the machine's removal; done once `get` says it is gone.
    async fn destroy(&self, id: &str) -> Result<(), CloudError>;
}
